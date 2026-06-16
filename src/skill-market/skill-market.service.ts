import { SkillRanker } from './skill-ranker';
import {
  LoadSkillResult,
  SearchSkillInput,
  SearchSkillResult,
  SkillMarketEntry,
  SkillResourceManifestEntry,
} from './skill-market.types';
import { SkillMarketNotFoundError, SkillMarketValidationError } from './skill-market.errors';
import { appendFileSync } from 'fs';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;
const MAX_QUERY_CHARS = 2000;

function logQuery(query: string, result: SearchSkillResult): void {
  const logPath = process.env.SKILL_MARKET_QUERY_LOG;
  if (!logPath) return;
  try {
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        query,
        results: result.results.map((r) => ({ skillId: r.skillId, name: r.name, score: r.score })),
      }) + '\n',
      'utf-8',
    );
  } catch {
    // silent
  }
}

/**
 * Lightweight index entry for ranking (subset of SkillMarketEntry).
 * We keep using SkillMarketEntry shape for ranker reuse.
 */
export interface SkillIndexItem {
  skillId: string;
  name: string;
  description: string;
  whenToUse?: string;
  disabledForModel: boolean;
}

export interface SkillContentLoader {
  loadBodyAndResources(skillId: string): Promise<{ body: string; resources: SkillResourceManifestEntry[]; extra?: Record<string, unknown> }>;
  getArchiveInfo(skillId: string): Promise<{ tosObjectKey: string; sha256: string; sizeBytes?: number }>;
}

/**
 * SkillMarketService core (framework agnostic).
 * - search: uses in-memory ranker over lightweight index (name/desc/whenToUse)
 * - loadSkill: delegates to contentLoader (PG row for new service, or FS for legacy)
 * - For download the caller (controller) uses storage directly with key from getArchiveInfo
 */
export class SkillMarketService {
  private _index: SkillMarketEntry[] = [];
  private _entriesById: Map<string, SkillMarketEntry> = new Map();
  private readonly contentLoader?: SkillContentLoader;
  private readonly indexProvider?: () => SkillIndexItem[];
  private readonly versionProvider?: () => number;
  private lastIndexVersion = -1;

  constructor(
    indexItemsOrProvider: SkillIndexItem[] | (() => SkillIndexItem[]),
    private readonly maxResourceBytes: number,
    private readonly ranker = new SkillRanker(),
    contentLoader?: SkillContentLoader,
    versionProvider?: () => number,
  ) {
    if (typeof indexItemsOrProvider === 'function') {
      this.indexProvider = indexItemsOrProvider;
      this.versionProvider = versionProvider;
      this.refreshIndex();
    } else {
      this.setIndex(indexItemsOrProvider);
    }
    this.contentLoader = contentLoader;
  }

  private setIndex(items: SkillIndexItem[]) {
    this._index = items.map((it) => ({
      skillId: it.skillId,
      source: 'market',
      name: it.name,
      description: it.description,
      whenToUse: it.whenToUse,
      disabledForModel: it.disabledForModel,
      resources: [],
    }));
    this._index.sort((a, b) => a.skillId.localeCompare(b.skillId));
    this._entriesById = new Map(this._index.map((e) => [e.skillId, e]));
  }

  private refreshIndex() {
    if (!this.indexProvider) return;

    if (this.versionProvider) {
      const currentVer = this.versionProvider();
      if (currentVer === this.lastIndexVersion && this._index.length > 0) {
        // No change (or first time with data) — avoid full Map rebuild on every search
        return;
      }
      this.lastIndexVersion = currentVer;
    }

    // Either no version provider (always refresh) or version changed / first load
    this.setIndex(this.indexProvider());
  }

  private get index(): SkillMarketEntry[] {
    this.refreshIndex();
    return this._index;
  }

  private get entriesById(): Map<string, SkillMarketEntry> {
    this.refreshIndex();
    return this._entriesById;
  }

  static fromIndex(
    items: SkillIndexItem[],
    maxResourceBytes: number,
    loader?: SkillContentLoader,
  ): SkillMarketService {
    return new SkillMarketService(items, maxResourceBytes, new SkillRanker(), loader);
  }

  static fromIndexProvider(
    provider: () => SkillIndexItem[],
    maxResourceBytes: number,
    loader?: SkillContentLoader,
  ): SkillMarketService {
    return new SkillMarketService(provider, maxResourceBytes, new SkillRanker(), loader);
  }

  /**
   * Preferred for PG-backed usage: pass a versionProvider so that refreshIndex()
   * only rebuilds the internal Map when the underlying data actually changed.
   */
  static fromVersionedIndexProvider(
    provider: () => SkillIndexItem[],
    versionProvider: () => number,
    maxResourceBytes: number,
    loader?: SkillContentLoader,
  ): SkillMarketService {
    return new SkillMarketService(provider, maxResourceBytes, new SkillRanker(), loader, versionProvider);
  }

  // Legacy FS ctor (used by ingest-time validation or stdio MCP against FS catalog if desired)
  // Kept for compatibility with original scripts/skill-market-mcp.ts shape if someone ports it.
  // In this standalone we primarily use fromIndex + PG loader.

  searchSkill(input: SearchSkillInput): SearchSkillResult {
    const query = normalizeQuery(input.query);
    const topK = normalizeTopK(input.topK);
    const result: SearchSkillResult = {
      results: this.ranker.rank(query, this.index, topK).map(({ entry, score }) => ({
        skillId: entry.skillId,
        name: entry.name,
        description: entry.description,
        score,
      })),
    };
    logQuery(query, result);
    return result;
  }

  async loadSkill(skillId: string): Promise<LoadSkillResult> {
    const entry = this.requireEntry(skillId);
    if (this.contentLoader) {
      const loaded = await this.contentLoader.loadBodyAndResources(skillId);
      return {
        skillId: entry.skillId,
        name: entry.name,
        description: entry.description,
        body: loaded.body,
        resources: loaded.resources,
      };
    }
    // Fallback: if body was preloaded into the entry (legacy FS full load)
    if (entry.body) {
      return {
        skillId: entry.skillId,
        name: entry.name,
        description: entry.description,
        body: entry.body,
        resources: entry.resources || [],
      };
    }
    throw new SkillMarketNotFoundError(`content loader not configured and no preloaded body for ${skillId}`);
  }

  async getArchiveInfo(skillId: string): Promise<{ tosObjectKey: string; sha256: string; sizeBytes?: number }> {
    if (this.contentLoader) {
      return this.contentLoader.getArchiveInfo(skillId);
    }
    const entry = this.requireEntry(skillId);
    if (entry.tosObjectKey && entry.archiveSha256) {
      return {
        tosObjectKey: entry.tosObjectKey,
        sha256: entry.archiveSha256,
        sizeBytes: entry.archiveSizeBytes,
      };
    }
    throw new SkillMarketNotFoundError(`archive info not available for ${skillId}`);
  }

  listEntries(): SkillMarketEntry[] {
    return [...this.index];
  }

  private requireEntry(skillId: string): SkillMarketEntry {
    if (!skillId?.trim()) throw new SkillMarketValidationError('skillId is required');
    const entry = this.entriesById.get(skillId);
    if (!entry) throw new SkillMarketNotFoundError(`skill not found: ${skillId}`);
    return entry;
  }
}

function normalizeQuery(query: string): string {
  if (typeof query !== 'string' || !query.trim()) {
    throw new SkillMarketValidationError('query must be a non-empty string');
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new SkillMarketValidationError(`query must be at most ${MAX_QUERY_CHARS} characters`);
  }
  return query.trim();
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) return DEFAULT_TOP_K;
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new SkillMarketValidationError(`topK must be an integer between 1 and ${MAX_TOP_K}`);
  }
  return topK;
}
