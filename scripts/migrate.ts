#!/usr/bin/env node
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  try {
    const migrationPath = resolve(__dirname, '../migrations/001_skill_market.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    console.log('Applying 001_skill_market.sql ...');
    await pool.query(sql);
    console.log('Migration applied successfully.');
  } catch (err: any) {
    console.error('Migration failed:', err?.message ?? err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
