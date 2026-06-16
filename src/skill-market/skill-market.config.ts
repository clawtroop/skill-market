import { SkillMarketConfigError } from './skill-market.errors';

export interface SkillMarketRuntimeConfig {
  databaseUrl: string;
  maxResourceBytes: number;
  // TOS
  tosEndpoint: string;
  tosAccessKey: string;
  tosSecretKey: string;
  tosBucket: string;
  tosRegion?: string;
  tosPrefix: string; // e.g. 'skills/'
  // Public base url used to build archive_url in responses
  publicBaseUrl?: string;
}

export interface IngestConfig {
  catalogRoot: string; // FS path to the 501 skill dirs
  databaseUrl: string;
  // TOS same as runtime
  tosEndpoint: string;
  tosAccessKey: string;
  tosSecretKey: string;
  tosBucket: string;
  tosRegion?: string;
  tosPrefix: string;
  dryRun?: boolean;
}

const DEFAULT_MAX_RESOURCE_BYTES = 1024 * 1024; // 1MB per resource (tune as needed)

export function loadSkillMarketRuntimeConfig(env: NodeJS.ProcessEnv = process.env): SkillMarketRuntimeConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new SkillMarketConfigError('DATABASE_URL is required');
  }

  const maxResourceBytes = parseMaxResourceBytes(env.SKILL_MARKET_MAX_RESOURCE_BYTES);

  const tosEndpoint = requireEnv('TOS_ENDPOINT', env);
  const tosAccessKey = requireEnv('TOS_ACCESS_KEY', env);
  const tosSecretKey = requireEnv('TOS_SECRET_KEY', env);
  const tosBucket = requireEnv('TOS_BUCKET', env);
  const tosRegion = env.TOS_REGION?.trim() || undefined;
  const tosPrefix = (env.TOS_PREFIX || 'skills/').trim();

  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim() || undefined;

  return {
    databaseUrl,
    maxResourceBytes,
    tosEndpoint,
    tosAccessKey,
    tosSecretKey,
    tosBucket,
    tosRegion,
    tosPrefix,
    publicBaseUrl,
  };
}

export function loadIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const catalogRoot = env.SKILL_MARKET_INGEST_CATALOG_ROOT?.trim();
  if (!catalogRoot) {
    throw new SkillMarketConfigError('SKILL_MARKET_INGEST_CATALOG_ROOT is required for ingest (path to .../skill-market/skills )');
  }

  const databaseUrl = requireEnv('DATABASE_URL', env);

  const tosEndpoint = requireEnv('TOS_ENDPOINT', env);
  const tosAccessKey = requireEnv('TOS_ACCESS_KEY', env);
  const tosSecretKey = requireEnv('TOS_SECRET_KEY', env);
  const tosBucket = requireEnv('TOS_BUCKET', env);
  const tosRegion = env.TOS_REGION?.trim() || undefined;
  const tosPrefix = (env.TOS_PREFIX || 'skills/').trim();

  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';

  return {
    catalogRoot,
    databaseUrl,
    tosEndpoint,
    tosAccessKey,
    tosSecretKey,
    tosBucket,
    tosRegion,
    tosPrefix,
    dryRun,
  };
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name]?.trim();
  if (!v) throw new SkillMarketConfigError(`${name} is required`);
  return v;
}

function parseMaxResourceBytes(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_MAX_RESOURCE_BYTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new SkillMarketConfigError('SKILL_MARKET_MAX_RESOURCE_BYTES must be a positive integer');
  }
  return value;
}
