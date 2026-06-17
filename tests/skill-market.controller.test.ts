import 'reflect-metadata';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SkillMarketController } from '../src/skill-market/skill-market.controller';
import { SkillMarketRepository, SkillMarketRow } from '../src/skill-market/skill-market.repository';
import { SkillMarketService } from '../src/skill-market/skill-market.service';
import { TosStorageService } from '../src/common/storage/tos-storage.service';

const publicBaseUrl = 'http://skill-market.default.svc.cluster.local:4000';
const archiveBody = Buffer.from('fake gzipped skill archive');
const archiveSha256 = createHash('sha256').update(archiveBody).digest('hex');
const staleArchiveSha256 = '0c5b220571711aa465a03f8a857c6af0a2faf30da8b756276b2762645115d677';

const row: SkillMarketRow = {
  skill_id: 'shadcn-ui',
  name: 'shadcn-ui',
  description: 'Build UI with shadcn components.',
  when_to_use: null,
  disabled_for_model: false,
  body: '# shadcn-ui',
  resources: [],
  tos_object_key: 'skills/shadcn-ui.tar.gz',
  archive_sha256: staleArchiveSha256,
  archive_size_bytes: archiveBody.length,
  extra_metadata: null,
};

let app: INestApplication;

function parseBinary(res: any, callback: (err: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | Uint8Array | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', callback);
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.TOS_ENDPOINT = 'https://tos.example.com';
  process.env.TOS_ACCESS_KEY = 'test';
  process.env.TOS_SECRET_KEY = 'test';
  process.env.TOS_BUCKET = 'test-bucket';
  process.env.PUBLIC_BASE_URL = publicBaseUrl;

  const moduleRef = await Test.createTestingModule({
    controllers: [SkillMarketController],
    providers: [
      {
        provide: SkillMarketService,
        useValue: {
          searchSkill: () => ({ results: [] }),
          listEntries: () => [],
        },
      },
      {
        provide: SkillMarketRepository,
        useValue: {
          findById: async (skillId: string) => (skillId === row.skill_id ? row : undefined),
        },
      },
      {
        provide: TosStorageService,
        useValue: {
          headObject: async () => ({ contentLength: archiveBody.length, contentType: 'application/gzip' }),
          getObjectBuffer: async () => archiveBody,
        },
      },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterEach(async () => {
  await app.close();
});

describe('SkillMarketController download endpoints', () => {
  test('POST /v1/skills/:skillId/download returns JSON metadata', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/skills/shadcn-ui/download')
      .send({
        agent_id: 'agent_xxx',
        run_id: 'run_xxx',
        workspace_id: 'ws_xxx',
        path_spec: {
          workspace_root: '/workspace',
          project_dir: '/workspace/project',
        },
        skill_id: 'shadcn-ui',
        name: 'shadcn-ui',
        source: 'market',
      })
      .expect(200)
      .expect('Content-Type', /json/);

    assert.deepEqual(res.body, {
      skill_id: 'shadcn-ui',
      name: 'shadcn-ui',
      archive_url: `${publicBaseUrl}/v1/skills/shadcn-ui/download`,
      content_hash: `sha256:${archiveSha256}`,
      entrypoint: 'SKILL.md',
    });
  });

  test('GET /v1/skills/:skillId/download still returns application/gzip', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/skills/shadcn-ui/download')
      .buffer(true)
      .parse(parseBinary)
      .expect(200)
      .expect('Content-Type', /application\/gzip/);

    assert.equal(Buffer.compare(res.body, archiveBody), 0);
    assert.equal(res.headers['x-skill-sha256'], archiveSha256);
    assert.notEqual(res.headers['x-skill-sha256'], staleArchiveSha256);
  });

  test('metadata archive_url points to an accessible archive endpoint', async () => {
    const metadata = await request(app.getHttpServer())
      .post('/v1/skills/shadcn-ui/download')
      .send({ skill_id: 'shadcn-ui', source: 'market' })
      .expect(200);

    const archivePath = new URL(metadata.body.archive_url).pathname;
    await request(app.getHttpServer())
      .get(archivePath)
      .buffer(true)
      .parse(parseBinary)
      .expect(200)
      .expect('Content-Type', /application\/gzip/);
  });

  test('metadata content_hash matches the actual archive sha256', async () => {
    const metadata = await request(app.getHttpServer())
      .post('/v1/skills/shadcn-ui/download')
      .send({ skill_id: 'shadcn-ui', source: 'market' })
      .expect(200);

    const archivePath = new URL(metadata.body.archive_url).pathname;
    const archive = await request(app.getHttpServer())
      .get(archivePath)
      .buffer(true)
      .parse(parseBinary)
      .expect(200);

    const actualHash = createHash('sha256').update(archive.body).digest('hex');
    assert.equal(metadata.body.content_hash, `sha256:${actualHash}`);
    assert.equal(archive.headers['x-skill-sha256'], actualHash);
  });
});
