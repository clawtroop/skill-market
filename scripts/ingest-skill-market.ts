#!/usr/bin/env node
/**
 * Ingest script: scan reference skill-market/skills/* dirs (501 skills),
 * parse SKILL.md, tar.gz the whole dir (root of tar contains SKILL.md + assets/...),
 * upload to Volcano TOS under skills/{skill_id}/skill.tar.gz,
 * upsert metadata + manifest + sha + body into Postgres.
 *
 * Usage:
 *   npm run ingest
 *   DRY_RUN=1 npm run ingest:dry
 *
 * Env:
 *   SKILL_MARKET_INGEST_CATALOG_ROOT  (required)
 *   DATABASE_URL, TOS_* required
 */
import 'reflect-metadata';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as tar from 'tar';
import { Pool } from 'pg';
import { TosClient } from '@volcengine/tos-sdk';
import { loadIngestConfig } from '../src/skill-market/skill-market.config';
import {
  SkillCatalogLoader,
  parseSkillFrontmatter,
} from '../src/skill-market/skill-catalog-loader';
import { SkillMarketEntry } from '../src/skill-market/skill-market.types';

async function main() {
  const cfg = loadIngestConfig();
  const dry = !!cfg.dryRun;

  console.log('Ingest config:');
  console.log('  catalogRoot :', cfg.catalogRoot);
  console.log('  tosBucket   :', cfg.tosBucket);
  console.log('  tosPrefix   :', cfg.tosPrefix);
  console.log('  dryRun      :', dry);
  console.log('');

  const pg = new Pool({ connectionString: cfg.databaseUrl, max: 4 });

  const tos = new TosClient({
    accessKeyId: cfg.tosAccessKey,
    accessKeySecret: cfg.tosSecretKey,
    endpoint: cfg.tosEndpoint,
    region: cfg.tosRegion || 'cn-beijing',
  } as any);

  const bucket = cfg.tosBucket;
  const prefix = cfg.tosPrefix.endsWith('/') ? cfg.tosPrefix : cfg.tosPrefix + '/';

  // Use loader to get validated entries (it will throw on bad frontmatter / paths)
  const loader = new SkillCatalogLoader();
  let entries: SkillMarketEntry[] = [];
  try {
    entries = loader.loadCatalog([{ source: 'market', root: cfg.catalogRoot }]);
  } catch (e: any) {
    // If loader enforces source:slug ids, we still want flat slugs for external API.
    // Fallback: manual scan + reuse parse fn for every top level dir.
    console.warn('Loader with source prefix returned error or empty, falling back to flat slug scan:', e?.message);
    entries = manualScanCatalog(cfg.catalogRoot);
  }

  console.log(`Found ${entries.length} skills to ingest.`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const slug = entry.slug || entry.skillId.split(':').pop() || entry.skillId;
    const skillId = slug; // flat id for the public API and DB PK
    const skillDir = entry.skillDirPath!;

    try {
      // 1. Build tar.gz of the skill dir contents (tar root has SKILL.md directly)
      const tmpDir = mkdtempSync(join(tmpdir(), 'skill-ingest-'));
      const tarPath = join(tmpDir, `${skillId}.tar.gz`);

      await tar.create(
        {
          gzip: true,
          file: tarPath,
          cwd: skillDir,
        },
        ['.'],
      );

      const tarBuffer = readFileSync(tarPath);
      const sha256 = createHash('sha256').update(tarBuffer).digest('hex');
      const size = tarBuffer.length;

      const tosKey = `${prefix}${skillId}/skill.tar.gz`.replace(/\/+/g, '/');

      if (dry) {
        console.log(`[DRY] ${skillId}: tar=${size}B sha=${sha256} key=${tosKey}`);
        rmSync(tmpDir, { recursive: true, force: true });
        skipped++;
        continue;
      }

      // 2. Upload
      await tos.putObject({
        bucket,
        key: tosKey,
        body: tarBuffer,
        contentType: 'application/gzip',
      });

      // 3. Read full body again (or from entry) + frontmatter extras
      const body = entry.body || readFileSync(entry.skillPath!, 'utf-8');
      let extra: Record<string, unknown> = entry.extraMetadata || {};
      try {
        // reparse to make sure we have latest extras
        const fm = parseSkillFrontmatter(entry.skillPath!, body);
        extra = fm.extra || extra;
      } catch {}

      // 4. Upsert row
      const resourcesJson = entry.resources || [];
      await pg.query(
        `INSERT INTO skill_market_items (
           skill_id, name, description, when_to_use, disabled_for_model,
           body, resources, tos_object_key, archive_sha256, archive_size_bytes, extra_metadata, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (skill_id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           when_to_use = EXCLUDED.when_to_use,
           disabled_for_model = EXCLUDED.disabled_for_model,
           body = EXCLUDED.body,
           resources = EXCLUDED.resources,
           tos_object_key = EXCLUDED.tos_object_key,
           archive_sha256 = EXCLUDED.archive_sha256,
           archive_size_bytes = EXCLUDED.archive_size_bytes,
           extra_metadata = EXCLUDED.extra_metadata,
           updated_at = now()`,
        [
          skillId,
          entry.name,
          entry.description,
          entry.whenToUse ?? null,
          entry.disabledForModel ?? false,
          body,
          JSON.stringify(resourcesJson),
          tosKey,
          sha256,
          size,
          Object.keys(extra).length ? JSON.stringify(extra) : null,
        ],
      );

      console.log(`✓ ${skillId}  (${size}B, ${resourcesJson.length} resources)`);
      ok++;

      rmSync(tmpDir, { recursive: true, force: true });
    } catch (err: any) {
      console.error(`✗ ${skillId} failed: ${err?.message ?? err}`);
      failed++;
    }
  }

  await pg.end();

  console.log('\nIngest complete.');
  console.log(`  success: ${ok}`);
  console.log(`  skipped (dry): ${skipped}`);
  console.log(`  failed : ${failed}`);
}

function manualScanCatalog(catalogRoot: string): SkillMarketEntry[] {
  // Minimal fallback scanner that reuses parse + classify logic
  // (duplicates a bit of loader but guarantees flat ids)
  const { readdirSync, lstatSync, existsSync, realpathSync, readFileSync, statSync } = require('fs');
  const { join, relative, sep } = require('path');
  const { parseSkillFrontmatter, classifyResource, assertInside } = require('../src/skill-market/skill-catalog-loader');

  const SLUG = /^[a-zA-Z0-9_.-]+$/;
  const SKILL_FILE = 'SKILL.md';
  const EXCL = new Set(['.git', 'node_modules', 'dist']);

  const out: SkillMarketEntry[] = [];
  for (const name of readdirSync(catalogRoot).sort()) {
    if (name.startsWith('.')) continue;
    const dir = join(catalogRoot, name);
    if (!lstatSync(dir).isDirectory()) continue;
    if (!SLUG.test(name)) continue;
    const skillPath = join(dir, SKILL_FILE);
    if (!existsSync(skillPath)) continue;

    const realDir = realpathSync(dir);
    const realSkill = realpathSync(skillPath);
    assertInside(realDir, realSkill, 'skill escapes');

    const body = readFileSync(realSkill, 'utf-8');
    const fm = parseSkillFrontmatter(realSkill, body);

    // resources
    const resources: any[] = [];
    const visit = (d: string) => {
      for (const f of readdirSync(d).sort()) {
        if (f.startsWith('.') || EXCL.has(f)) continue;
        const p = join(d, f);
        const rp = realpathSync(p);
        assertInside(realDir, rp, 'resource escapes');
        const st = statSync(rp);
        if (st.isDirectory()) {
          visit(rp);
          continue;
        }
        if (!st.isFile() || rp === realSkill) continue;
        const relp = relative(realDir, rp).split(sep).join('/');
        const cl = classifyResource(rp);
        resources.push({ path: relp, kind: cl.kind, sizeBytes: st.size, mimeType: cl.mimeType });
      }
    };
    visit(realDir);
    resources.sort((a: any, b: any) => a.path.localeCompare(b.path));

    out.push({
      skillId: name,
      source: 'market',
      slug: name,
      skillDirPath: realDir,
      skillPath: realSkill,
      name: fm.name,
      description: fm.description,
      whenToUse: fm.whenToUse,
      disabledForModel: fm.disabledForModel,
      resources,
      body,
      extraMetadata: fm.extra,
    } as any);
  }
  return out.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
