#!/usr/bin/env node
/**
 * 生成 Postgres INSERT SQL（不连库、不碰 TOS）。
 *
 * 用途：你手动把 dist-archives/{skill_id}/skill.tar.gz 上传到 TOS 后，
 * 用本脚本生成一份 SQL，导入 Postgres 即可让服务可用。
 *
 * 关键：archive_sha256 / archive_size_bytes 直接读 dist-archives 里
 * 已打好的 tar.gz 计算，保证与你手动上传的对象逐字节一致。
 *
 * 用法：
 *   npm run gen:sql
 *   # 自定义源/输出/前缀：
 *   SRC=/path/to/skills ARCHIVES=./dist-archives TOS_PREFIX=skill-market-mcp/ \
 *     OUT=./dist-archives/skill_market_seed.sql node -r tsx/cjs scripts/gen-sql.ts
 */
import { createHash } from 'crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve, sep } from 'path';
import {
  parseSkillFrontmatter,
  classifyResource,
} from '../src/skill-market/skill-catalog-loader';
import { SkillResourceManifestEntry } from '../src/skill-market/skill-market.types';

const SRC = resolve(
  process.env.SRC ||
    '/Users/aweminds/Documents/agent-economic/agent-economic-harness/skill-market/skills',
);
const ARCHIVES = resolve(process.env.ARCHIVES || './dist-archives');
// 注意：实际上传时在前缀下又套了一层 skills/，所以对象路径为
//   skill-market-mcp/skills/{skill_id}/skill.tar.gz
// 这里的默认前缀必须与之对齐，否则 download 接口按 key 取对象会 404。
const RAW_PREFIX = process.env.TOS_PREFIX || 'skill-market-mcp/skills/';
const PREFIX = RAW_PREFIX.endsWith('/') ? RAW_PREFIX : RAW_PREFIX + '/';
const OUT = resolve(process.env.OUT || './dist-archives/skill_market_seed.sql');

const SLUG = /^[a-zA-Z0-9_.-]+$/;
const SKILL_FILE = 'SKILL.md';
const EXCL = new Set(['.git', 'node_modules', 'dist']);

/** dollar-quoting：为内容选一个不冲突的 $tag$，安全包裹任意文本 */
function dollarQuote(text: string): string {
  let tag = 'b';
  while (text.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${text}$${tag}$`;
}

/** SQL 普通字符串字面量转义（单引号翻倍） */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function jsonLiteral(obj: unknown): string {
  // JSONB 用 dollar-quoting 包裹，避免内部引号转义
  return dollarQuote(JSON.stringify(obj));
}

function scanResources(realDir: string, realSkill: string): SkillResourceManifestEntry[] {
  const out: SkillResourceManifestEntry[] = [];
  const visit = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      if (f.startsWith('.') || EXCL.has(f)) continue;
      const p = join(dir, f);
      const rp = realpathSync(p);
      const st = statSync(rp);
      if (st.isDirectory()) {
        visit(rp);
        continue;
      }
      if (!st.isFile() || rp === realSkill) continue;
      const relp = relative(realDir, rp).split(sep).join('/');
      const cl = classifyResource(rp);
      out.push({ path: relp, kind: cl.kind, sizeBytes: st.size, mimeType: cl.mimeType });
    }
  };
  visit(realDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  if (!existsSync(SRC)) throw new Error(`源目录不存在: ${SRC}`);
  if (!existsSync(ARCHIVES)) throw new Error(`归档目录不存在(请先跑 pack-archives.sh): ${ARCHIVES}`);

  const lines: string[] = [];
  lines.push('-- Skill Market seed data. 由 scripts/gen-sql.ts 生成。');
  lines.push('-- 执行前请确保 skill_market_items 表结构已存在。');
  lines.push('BEGIN;');
  lines.push('');

  let ok = 0;
  let skip = 0;
  let missingArchive = 0;

  for (const name of readdirSync(SRC).sort()) {
    if (name.startsWith('.')) continue;
    const dir = join(SRC, name);
    if (!lstatSync(dir).isDirectory()) continue;
    if (!SLUG.test(name)) continue;
    const skillPath = join(dir, SKILL_FILE);
    if (!existsSync(skillPath)) {
      skip++;
      continue;
    }

    const realDir = realpathSync(dir);
    const realSkill = realpathSync(skillPath);
    const body = readFileSync(realSkill, 'utf-8');
    const fm = parseSkillFrontmatter(realSkill, body);

    // 读取已打好的归档算 sha/size（保证与上传对象一致）
    const archivePath = join(ARCHIVES, name, 'skill.tar.gz');
    if (!existsSync(archivePath)) {
      console.warn(`! 缺归档，跳过: ${name} (${archivePath})`);
      missingArchive++;
      continue;
    }
    const archiveBuf = readFileSync(archivePath);
    const sha256 = createHash('sha256').update(archiveBuf).digest('hex');
    const sizeBytes = archiveBuf.length;

    const resources = scanResources(realDir, realSkill);
    const tosKey = `${PREFIX}${name}/skill.tar.gz`.replace(/\/+/g, '/');
    const extra = fm.extra || {};
    const hasExtra = Object.keys(extra).length > 0;

    lines.push(
      `INSERT INTO skill_market_items (skill_id, source, name, description, when_to_use, disabled_for_model, body, resources, tos_object_key, archive_sha256, archive_size_bytes, extra_metadata)`,
    );
    lines.push(
      `VALUES (${sqlStr(name)}, 'market', ${sqlStr(fm.name)}, ${sqlStr(fm.description)}, ${
        fm.whenToUse ? sqlStr(fm.whenToUse) : 'NULL'
      }, ${fm.disabledForModel ? 'true' : 'false'}, ${dollarQuote(body)}, ${jsonLiteral(
        resources,
      )}::jsonb, ${sqlStr(tosKey)}, ${sqlStr(sha256)}, ${sizeBytes}, ${
        hasExtra ? `${jsonLiteral(extra)}::jsonb` : 'NULL'
      })`,
    );
    lines.push(
      `ON CONFLICT (skill_id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, when_to_use=EXCLUDED.when_to_use, disabled_for_model=EXCLUDED.disabled_for_model, body=EXCLUDED.body, resources=EXCLUDED.resources, tos_object_key=EXCLUDED.tos_object_key, archive_sha256=EXCLUDED.archive_sha256, archive_size_bytes=EXCLUDED.archive_size_bytes, extra_metadata=EXCLUDED.extra_metadata, updated_at=now();`,
    );
    lines.push('');
    ok++;
  }

  lines.push('COMMIT;');
  lines.push('');
  writeFileSync(OUT, lines.join('\n'), 'utf-8');

  console.log('SQL 生成完成：');
  console.log(`  写入行  : ${ok}`);
  console.log(`  无SKILL : ${skip}`);
  console.log(`  缺归档  : ${missingArchive}`);
  console.log(`  前缀    : ${PREFIX}`);
  console.log(`  输出    : ${OUT}`);
}

main();
