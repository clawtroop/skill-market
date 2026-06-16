import { Module } from '@nestjs/common';
import { SkillMarketModule } from './skill-market/skill-market.module';

@Module({
  imports: [SkillMarketModule],
})
export class AppModule {}
