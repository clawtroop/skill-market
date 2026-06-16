import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PgPool } from '../common/persistence/pg-pool';
import { SkillMarketConfigError } from './skill-market.errors';
import { SkillIndexItem, SkillContentLoader } from './skill-market.service';
import { SkillResourceManifestEntry } from './skill-market.types';
import { TosStorageService } from '../common/storage/tos-storage.service';
import { loadSkillMarketRuntimeConfig } from './skill-market.config';

export interface SkillMarketRow {
  skill_id: string;
  name: string;
  description: string;
  when_to_use: string | null;
  disabled_for_model: boolean;
  body: string;
  resources: SkillResourceManifestEntry[];
  tos_object_key: string;
  archive_sha256: string;
  archive_size_bytes: number | null;
  extra_metadata: Record<string, unknown> | null;
}

@Injectable()
export class SkillMarketRepository implements OnModuleInit, SkillContentLoader {
  private readonly logger = new Logger('SkillMarketRepository');
  private indexCache: SkillIndexItem[] = [];

  constructor(
    private readonly pg: PgPool,
    private readonly tos: TosStorageService,
  ) {}

  private indexVersion = 0;

  async onModuleInit(): Promise<void> {
    if (!this.pg.enabled) {
      this.logger.warn('DATABASE_URL not set — SkillMarketRepository will have empty index (no data)');
      return;
    }
    await this.reloadIndex();
    this.logger.log(`SkillMarket index loaded: ${this.indexCache.length} skills (v${this.indexVersion})`);
  }

  async reloadIndex(): Promise<void> {
    try {
      const rows = await this.pg.query<Partial<SkillMarketRow>>(
        `SELECT skill_id, name, description, when_to_use, disabled_for_model
         FROM skill_market_items
         WHERE disabled_for_model = false
         ORDER BY skill_id ASC`,
      );
      this.indexCache = rows.map((r) => ({
        skillId: r.skill_id!,
        name: r.name!,
        description: r.description!,
        whenToUse: r.when_to_use || undefined,
        disabledForModel: !!r.disabled_for_model,
      }));
      this.indexVersion = (this.indexVersion + 1) | 0;
    } catch (err: any) {
      // Table may not exist yet (before migrate). Keep previous cache (usually empty) and do not bump version.
      this.logger.warn(`reloadIndex failed (table may be missing): ${err?.message ?? err}`);
      // Do not increment version so callers know data is stale/empty.
    }
  }

  getIndex(): SkillIndexItem[] {
    return [...this.indexCache];
  }

  /** Monotonic version bumped on successful reload. Used by service to avoid unnecessary Map rebuilds. */
  getIndexVersion(): number {
    return this.indexVersion;
  }

  async findById(skillId: string): Promise<SkillMarketRow | undefined> {
    const rows = (await this.pg.query(
      `SELECT * FROM skill_market_items WHERE skill_id = $1 LIMIT 1`,
      [skillId],
    )) as unknown as SkillMarketRow[];
    return rows[0];
  }

  // SkillContentLoader impl
  async loadBodyAndResources(skillId: string): Promise<{ body: string; resources: SkillResourceManifestEntry[]; extra?: Record<string, unknown> }> {
    const row = await this.findById(skillId);
    if (!row) throw new Error(`skill not found in db: ${skillId}`);
    return {
      body: row.body,
      resources: row.resources || [],
      extra: row.extra_metadata || undefined,
    };
  }

  async getArchiveInfo(skillId: string): Promise<{ tosObjectKey: string; sha256: string; sizeBytes?: number }> {
    const row = await this.findById(skillId);
    if (!row) throw new Error(`skill not found in db: ${skillId}`);
    return {
      tosObjectKey: row.tos_object_key,
      sha256: row.archive_sha256,
      sizeBytes: row.archive_size_bytes ?? undefined,
    };
  }

  // Used by ingest (and admin)
  async upsertSkill(row: {
    skill_id: string;
    name: string;
    description: string;
    when_to_use?: string | null;
    disabled_for_model?: boolean;
    body: string;
    resources: SkillResourceManifestEntry[];
    tos_object_key: string;
    archive_sha256: string;
    archive_size_bytes: number;
    extra_metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.pg.query(
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
        row.skill_id,
        row.name,
        row.description,
        row.when_to_use ?? null,
        row.disabled_for_model ?? false,
        row.body,
        JSON.stringify(row.resources || []),
        row.tos_object_key,
        row.archive_sha256,
        row.archive_size_bytes,
        row.extra_metadata ? JSON.stringify(row.extra_metadata) : null,
      ],
    );
  }
}
