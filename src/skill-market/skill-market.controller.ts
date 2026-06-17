import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { SkillMarketService } from './skill-market.service';
import { SkillMarketExceptionFilter } from './skill-market-exception.filter';
import { SkillMarketRepository } from './skill-market.repository';
import { TosStorageService } from '../common/storage/tos-storage.service';
import { loadSkillMarketRuntimeConfig } from './skill-market.config';
import {
  ExternalSkillDownloadMetadata,
  ExternalSearchResult,
  ExternalSearchSkillItem,
} from './skill-market.types';

interface SearchBody {
  query: string;
  topK?: number;
  // Per spec, extra hints are accepted but ignored for core ranking in v1
  task_type?: string;
  repo_hints?: unknown;
  user_context?: unknown;
  max_results?: number;
}

interface DownloadMetadataBody {
  agent_id?: string;
  run_id?: string;
  workspace_id?: string;
  path_spec?: {
    workspace_root?: string;
    project_dir?: string;
  };
  skill_id?: string;
  name?: string;
  source?: string;
}

@UseFilters(SkillMarketExceptionFilter)
@Controller()
export class SkillMarketController {
  private readonly logger = new Logger(SkillMarketController.name);
  private readonly publicBase: string;

  constructor(
    @Inject(SkillMarketService)
    private readonly market: SkillMarketService,
    @Inject(SkillMarketRepository)
    private readonly repo: SkillMarketRepository,
    @Inject(TosStorageService)
    private readonly tos: TosStorageService,
  ) {
    const cfg = loadSkillMarketRuntimeConfig();
    this.publicBase = cfg.publicBaseUrl || '';
  }

  private buildArchiveUrl(skillId: string): string {
    const base = this.publicBase || ''; // if empty, controller can also use relative or let caller know
    return `${base.replace(/\/$/, '')}/v1/skills/${encodeURIComponent(skillId)}/download`;
  }

  private buildContentHash(sha256?: string | null): string | undefined {
    if (!sha256) return undefined;
    return sha256.startsWith('sha256:') ? sha256 : `sha256:${sha256}`;
  }

  @Post('/v1/skills/search')
  async search(@Body() body: SearchBody): Promise<ExternalSearchResult> {
    const topK = body.topK ?? body.max_results ?? 5;
    const raw = this.market.searchSkill({ query: body.query, topK });

    const skills: ExternalSearchSkillItem[] = raw.results.map((r) => {
      // confidence: reuse lexical score (0-1 range), clamp just in case
      const confidence = Math.max(0, Math.min(1, r.score));
      const reason = `lexical overlap match (score=${r.score.toFixed(4)})`;
      return {
        skill_id: r.skillId,
        name: r.name,
        description: r.description,
        confidence,
        reason,
        // 直接给出完整包下载直链；agent 命中即可下载，无需再走详情接口。
        // sha256 由 download 响应头 X-Skill-SHA256 提供，search 保持纯内存零查询。
        archive_url: this.buildArchiveUrl(r.skillId),
      };
    });

    return { skills };
  }

  @Post('/v1/skills/:skillId/download')
  @HttpCode(200)
  async downloadMetadata(
    @Param('skillId') skillId: string,
    @Body() _body: DownloadMetadataBody,
  ): Promise<ExternalSkillDownloadMetadata> {
    const row = await this.repo.findById(skillId);
    if (!row) {
      throw new NotFoundException(`skill not found: ${skillId}`);
    }

    return {
      skill_id: row.skill_id,
      name: row.name || skillId,
      archive_url: this.buildArchiveUrl(skillId),
      content_hash: this.buildContentHash(row.archive_sha256),
      entrypoint: 'SKILL.md',
    };
  }

  @Get('/v1/skills/:skillId/download')
  async download(@Param('skillId') skillId: string, @Res() res: Response, @Headers() headers: Record<string, string>) {
    const row = await this.repo.findById(skillId);
    if (!row) {
      res.status(404).json({ message: `skill not found: ${skillId}` });
      return;
    }

    const key = row.tos_object_key;
    // Optional range support could be added; for v1 simple full download
    const head = await this.tos.headObject(key);

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${skillId}-skill.tar.gz"`);
    res.setHeader('X-Skill-ID', skillId);
    if (row.archive_sha256) res.setHeader('X-Skill-SHA256', row.archive_sha256);
    if (row.name) res.setHeader('X-Skill-Name', row.name);
    if (head.contentLength) res.setHeader('Content-Length', head.contentLength);

    // Use buffer path for maximum reliability with Volcano TOS (avoids stream shape guessing).
    // Skill tarballs are small-to-medium (documentation + scripts/assets); buffering is safe and simple.
    try {
      const buf = await this.tos.getObjectBuffer(key);
      // Ensure Content-Length if head didn't provide it (or was 0)
      if (!head.contentLength && buf.length > 0) {
        res.setHeader('Content-Length', buf.length);
      }
      res.end(buf);
    } catch (err: any) {
      this.logger.error(`Failed to fetch skill archive ${skillId} from storage: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.status(502).json({ message: 'failed to fetch archive from storage' });
      }
    }
  }

  // Simple health / count for ops
  @Get('/v1/skills')
  async list(@Query('limit') limitStr?: string) {
    const limit = Math.min(100, Math.max(1, Number(limitStr) || 20));
    const items = this.market.listEntries().slice(0, limit).map((e) => ({
      skill_id: e.skillId,
      name: e.name,
      description: e.description,
    }));
    return { count: this.market.listEntries().length, items };
  }
}
