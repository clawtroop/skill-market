import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SkillMarketExceptionFilter } from './skill-market/skill-market-exception.filter';

function loadEnvFallback() {
  if (process.env.DATABASE_URL) return;
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath) && typeof (process as any).loadEnvFile === 'function') {
    (process as any).loadEnvFile(envPath);
  }
}

async function bootstrap() {
  loadEnvFallback();

  const corsOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: corsOrigins?.length ? corsOrigins : true,
      credentials: true,
    },
  });

  // Global prefix empty to match spec /v1/...
  app.setGlobalPrefix('');

  // Simple internal token guard for paths starting with /internal (if you add any admin endpoints later)
  app.use((req: any, res: any, next: any) => {
    const token = process.env.INTERNAL_API_TOKEN;
    if (token && typeof req.path === 'string' && req.path.startsWith('/internal')) {
      const provided = req.header?.('x-internal-token') ?? req.headers?.['x-internal-token'];
      if (provided !== token) {
        return res.status(403).json({ error: 'internal API token required' });
      }
    }
    return next();
  });

  // Attach the domain exception filter at root too (module already uses it locally)
  app.useGlobalFilters(new SkillMarketExceptionFilter());

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Skill Market service listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log('Endpoints: POST /v1/skills/search , GET /v1/skills/{id}/download');
}

void bootstrap();
