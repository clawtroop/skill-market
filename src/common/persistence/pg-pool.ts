import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class PgPool implements OnModuleDestroy {
  private readonly logger = new Logger('PgPool');
  private readonly pool?: Pool;
  readonly enabled: boolean;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    this.enabled = Boolean(connectionString);
    if (connectionString) {
      this.pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 8000 });
      this.pool.on('error', (err) => this.logger.error(`pg pool error: ${err.message}`));
    }
  }

  get raw(): Pool {
    if (!this.pool) throw new Error('PgPool not enabled: DATABASE_URL not configured');
    return this.pool;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    const res = await this.raw.query(text, params as never[]);
    return res.rows as T[];
  }

  async getClient(): Promise<PoolClient> {
    return this.raw.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
