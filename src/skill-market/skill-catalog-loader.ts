import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { parse as parseYaml } from 'yaml';
import { SkillMarketCatalogError } from './skill-market.errors';
import {
  SkillMarketCatalogSource,
  SkillMarketEntry,
  SkillResourceKind,
  SkillResourceManifestEntry,
} from './skill-market.types';

const SKILL_FILE = 'SKILL.md';
const SLUG_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const EXCLUDED_RESOURCE_DIRS = new Set(['.git', 'node_modules', 'dist']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.ps1']);
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.toml',
  '.ini',
  '.env',
]);

interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  whenToUse?: string;
  disabledForModel: boolean;
  extra: Record<string, unknown>; // capture version, metadata, categories etc for external API
}

export class SkillCatalogLoader {
  loadCatalog(sources: SkillMarketCatalogSource[]): SkillMarketEntry[] {
    const entries = new Map<string, SkillMarketEntry>();
    for (const source of sources) {
      const rootPath = this.realCatalogRoot(source);
      for (const slug of readdirSync(rootPath).sort()) {
        const skillDirPath = join(rootPath, slug);
        if (!lstatSync(skillDirPath).isDirectory()) continue;
        if (!SLUG_PATTERN.test(slug)) {
          throw new SkillMarketCatalogError(`invalid skill slug ${slug} in ${rootPath}`);
        }
        const skillPath = join(skillDirPath, SKILL_FILE);
        if (!existsSync(skillPath)) continue;
        const skillId = `${source.source}:${slug}`;
        if (entries.has(skillId)) {
          throw new SkillMarketCatalogError(`duplicate skill id ${skillId}`);
        }
        const realSkillDirPath = realpathSync(skillDirPath);
        const realSkillPath = realpathSync(skillPath);
        assertInside(realSkillDirPath, realSkillPath, `skill file ${skillPath} escapes skill directory`);
        const body = readFileSync(realSkillPath, 'utf-8');
        const frontmatter = parseSkillFrontmatter(realSkillPath, body);
        entries.set(skillId, {
          skillId,
          source: source.source,
          catalogRoot: source.root,
          slug,
          skillDirPath: realSkillDirPath,
          skillPath: realSkillPath,
          name: frontmatter.name,
          description: frontmatter.description,
          whenToUse: frontmatter.whenToUse,
          disabledForModel: frontmatter.disabledForModel,
          resources: scanSkillResources(realSkillDirPath, realSkillPath),
          body,
          extraMetadata: frontmatter.extra,
        });
      }
    }
    return [...entries.values()].sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  private realCatalogRoot(source: SkillMarketCatalogSource): string {
    const rootPath = resolve(source.root);
    if (!existsSync(rootPath)) {
      throw new SkillMarketCatalogError(`catalog root does not exist for source ${source.source}: ${source.root}`);
    }
    const realRootPath = realpathSync(rootPath);
    if (!statSync(realRootPath).isDirectory()) {
      throw new SkillMarketCatalogError(`catalog root is not a directory for source ${source.source}: ${source.root}`);
    }
    return realRootPath;
  }
}

export function parseSkillFrontmatter(skillPath: string, body: string): ParsedSkillFrontmatter {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    throw new SkillMarketCatalogError(`skill is missing YAML frontmatter: ${skillPath}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (err: any) {
    throw new SkillMarketCatalogError(`invalid YAML frontmatter in ${skillPath}: ${err?.message ?? String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillMarketCatalogError(`frontmatter must be an object: ${skillPath}`);
  }

  const record = parsed as Record<string, unknown>;
  const name = requiredString(record, 'name', skillPath);
  const description = requiredString(record, 'description', skillPath);
  const whenToUse = optionalString(record, 'when_to_use', skillPath);
  const disabledForModel = optionalBoolean(record, 'disable-model-invocation', skillPath) ?? false;

  // Capture everything else (metadata, version, categories, tags, risk, source, date_added etc)
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!['name', 'description', 'when_to_use', 'disable-model-invocation'].includes(k)) {
      extra[k] = v;
    }
  }
  return { name, description, whenToUse, disabledForModel, extra };
}

export function assertResourcePath(relativePath: string): void {
  if (!relativePath || relativePath.includes('\0')) {
    throw new SkillMarketCatalogError('resource path must be a non-empty relative path');
  }
  if (isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new SkillMarketCatalogError(`resource path must be relative POSIX path: ${relativePath}`);
  }
  const parts = relativePath.split('/');
  if (parts.includes('') || parts.includes('.') || parts.includes('..')) {
    throw new SkillMarketCatalogError(`resource path contains invalid segment: ${relativePath}`);
  }
}

export function resolveSkillResourcePath(entry: SkillMarketEntry, relativePath: string): string {
  assertResourcePath(relativePath);
  const fullPath = join(entry.skillDirPath!, relativePath);
  if (!existsSync(fullPath)) {
    throw new SkillMarketCatalogError(`resource not found: ${relativePath}`);
  }
  const realPath = realpathSync(fullPath);
  assertInside(entry.skillDirPath!, realPath, `resource ${relativePath} escapes skill directory`);
  if (!statSync(realPath).isFile()) {
    throw new SkillMarketCatalogError(`resource is not a file: ${relativePath}`);
  }
  if (realPath === entry.skillPath) {
    throw new SkillMarketCatalogError('SKILL.md must be loaded with load_skill');
  }
  return realPath;
}

export function classifyResource(path: string): { kind: SkillResourceKind; mimeType: string } {
  const ext = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) return { kind: 'script', mimeType: mimeTypeForExtension(ext) };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text', mimeType: mimeTypeForExtension(ext) };
  return { kind: 'binary', mimeType: mimeTypeForExtension(ext) };
}

function scanSkillResources(skillDirPath: string, skillPath: string): SkillResourceManifestEntry[] {
  const resources: SkillResourceManifestEntry[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || EXCLUDED_RESOURCE_DIRS.has(name)) continue;
      const rawPath = join(dir, name);
      const realPath = realpathSync(rawPath);
      assertInside(skillDirPath, realPath, `resource ${rawPath} escapes skill directory`);
      const stat = statSync(realPath);
      if (stat.isDirectory()) {
        visit(realPath);
        continue;
      }
      if (!stat.isFile() || realPath === skillPath) continue;
      const relativePath = relative(skillDirPath, realPath).split(sep).join('/');
      const classification = classifyResource(realPath);
      resources.push({
        path: relativePath,
        kind: classification.kind,
        sizeBytes: stat.size,
        mimeType: classification.mimeType,
      });
    }
  };
  visit(skillDirPath);
  return resources.sort((a, b) => a.path.localeCompare(b.path));
}

function assertInside(root: string, candidate: string, message: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new SkillMarketCatalogError(message);
}

function requiredString(record: Record<string, unknown>, key: string, skillPath: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new SkillMarketCatalogError(`frontmatter field ${key} must be a non-empty string: ${skillPath}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, skillPath: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SkillMarketCatalogError(`frontmatter field ${key} must be a string: ${skillPath}`);
  }
  return value.trim() || undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string, skillPath: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new SkillMarketCatalogError(`frontmatter field ${key} must be a boolean: ${skillPath}`);
  }
  return value;
}

function mimeTypeForExtension(ext: string): string {
  switch (ext) {
    case '.md':
    case '.mdx':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    case '.csv':
      return 'text/csv';
    case '.html':
      return 'text/html';
    case '.css':
    case '.scss':
      return 'text/css';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript';
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.py':
      return 'text/x-python';
    case '.sh':
      return 'text/x-shellscript';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

// Re-export helpers for ingest script reuse
export { parseYaml };
