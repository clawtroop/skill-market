import { Module, OnModuleInit } from '@nestjs/common';
import { PgPool } from '../common/persistence/pg-pool';
import { TosStorageService } from '../common/storage/tos-storage.service';
import { SkillMarketController } from './skill-market.controller';
import { SkillMarketRepository } from './skill-market.repository';
import { SkillMarketService } from './skill-market.service';
import { SkillMarketExceptionFilter } from './skill-market-exception.filter';

@Module({
  controllers: [SkillMarketController],
  providers: [
    PgPool,
    TosStorageService,
    SkillMarketRepository,
    {
      provide: SkillMarketService,
      useFactory: (repo: SkillMarketRepository) => {
        // Use versioned provider so refreshIndex() skips expensive full Map rebuild when data is unchanged.
        const maxBytes = Number(process.env.SKILL_MARKET_MAX_RESOURCE_BYTES || 1024 * 1024);
        return SkillMarketService.fromVersionedIndexProvider(
          () => repo.getIndex(),
          () => repo.getIndexVersion(),
          maxBytes,
          repo,
        );
      },
      inject: [SkillMarketRepository],
    },
    SkillMarketExceptionFilter,
  ],
  exports: [SkillMarketService, SkillMarketRepository, TosStorageService],
})
export class SkillMarketModule implements OnModuleInit {
  constructor(private readonly repo: SkillMarketRepository) {}

  async onModuleInit() {
    // Ensure index is warm (repo onModuleInit already does it, but safe reload)
    if (this.repo.getIndex().length === 0) {
      await this.repo.reloadIndex().catch(() => undefined);
    }
  }
}
