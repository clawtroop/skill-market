export interface SkillMarketCatalogSource {
  source: string;
  root: string;
}

export interface SkillMarketConfig {
  // Legacy FS config (used only by ingest / optional MCP)
  catalogRoots?: SkillMarketCatalogSource[];
  maxResourceBytes: number;
}

export type SkillResourceKind = 'text' | 'script' | 'binary';

export interface SkillResourceManifestEntry {
  path: string;
  kind: SkillResourceKind;
  sizeBytes: number;
  mimeType: string;
}

export interface SkillMarketEntry {
  skillId: string;
  source: string;
  catalogRoot?: string;
  slug?: string;
  // For FS mode only (ingest/loader)
  skillDirPath?: string;
  skillPath?: string;
  name: string;
  description: string;
  whenToUse?: string;
  disabledForModel: boolean;
  resources: SkillResourceManifestEntry[];
  // New storage fields (populated for PG-backed service)
  body?: string; // full SKILL.md for load
  tosObjectKey?: string;
  archiveSha256?: string;
  archiveSizeBytes?: number;
  extraMetadata?: Record<string, unknown>;
}

export interface SearchSkillInput {
  query: string;
  topK?: number;
}

export interface SearchSkillResult {
  results: {
    skillId: string;
    name: string;
    description: string;
    score: number;
  }[];
}

export interface LoadSkillResult {
  skillId: string;
  name: string;
  description: string;
  body: string;
  resources: SkillResourceManifestEntry[];
}

export interface LoadSkillResourceResult {
  skillId: string;
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mimeType: string;
  sizeBytes: number;
}

// External API response shapes (per Skill Market 适配接入方案)
export interface ExternalSearchSkillItem {
  skill_id: string;
  name: string;
  description: string;
  confidence: number;
  reason: string;
  categories?: string[];
  tags?: string[];
  version?: string;
  content_hash?: string;
  requires?: {
    runtime_types?: string[];
    tools?: string[];
  };
}

export interface ExternalSearchResult {
  skills: ExternalSearchSkillItem[];
}

export interface ExternalSkillDetail {
  skill_id: string;
  name: string;
  description: string;
  version?: string;
  content_hash?: string;
  skill_md: string;
  package: {
    archive_url: string;
    sha256: string;
  };
  metadata: {
    categories?: string[];
    tags?: string[];
    entrypoint: string;
    [key: string]: unknown;
  };
}
