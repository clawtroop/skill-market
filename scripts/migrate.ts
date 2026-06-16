#!/usr/bin/env node
import 'reflect-metadata';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';

/** 脱敏打印连接串：只暴露 host/port/db/user，隐藏密码，便于排查连库目标对不对 */
function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `host=${u.hostname} port=${u.port || '5432'} db=${u.pathname.replace(/^\//, '')} user=${u.username || '(none)'} ssl=${u.searchParams.get('sslmode') || '(default)'}`;
  } catch {
    return '(无法解析 DATABASE_URL 格式)';
  }
}

async function main() {
  const startedAt = Date.now();
  console.log('[migrate] 启动 migrate initContainer ...');
  console.log(`[migrate] cwd=${process.cwd()} __dirname=${__dirname} node=${process.version}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] ❌ DATABASE_URL 未设置（检查 Secret skill-market-secret 是否注入）');
    process.exit(1);
  }
  console.log(`[migrate] DATABASE_URL -> ${describeDatabaseUrl(databaseUrl)}`);

  // 兼容两种运行位置：
  //   源码 tsx:   __dirname=/app/scripts        -> ../migrations
  //   编译产物:    __dirname=/app/dist/scripts   -> ../../migrations（migrations 不进 dist，在 /app 下）
  // 按候选路径探测，取第一个存在的，避免相对层级写死导致 ENOENT。
  const SQL_FILE = '001_skill_market.sql';
  const candidates = [
    resolve(__dirname, '../migrations', SQL_FILE),
    resolve(__dirname, '../../migrations', SQL_FILE),
    resolve(process.cwd(), 'migrations', SQL_FILE),
  ];
  const migrationPath = candidates.find((p) => existsSync(p));
  console.log(`[migrate] 迁移文件候选: ${candidates.join(' | ')}`);
  if (!migrationPath) {
    console.error('[migrate] ❌ 找不到迁移 SQL 文件（镜像未 COPY migrations/ 或路径不对）');
    process.exit(1);
  }
  console.log(`[migrate] 使用迁移文件: ${migrationPath}`);

  // 8s 连接超时，避免连库不通时容器一直挂起看不到错误
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 8000 });

  try {
    console.log('[migrate] 正在连接数据库并执行连通性探测 (SELECT 1) ...');
    await pool.query('SELECT 1');
    console.log('[migrate] ✅ 数据库连接成功');

    const sql = readFileSync(migrationPath, 'utf-8');
    console.log('[migrate] 执行 001_skill_market.sql ...');
    await pool.query(sql);
    console.log(`[migrate] ✅ 建表完成，用时 ${Date.now() - startedAt}ms`);
  } catch (err: any) {
    // 打出可定位根因的全部细节：错误码 / 目标地址 / 端口 / 原始消息
    console.error('[migrate] ❌ 迁移失败');
    console.error(`[migrate]   code=${err?.code} errno=${err?.errno} syscall=${err?.syscall}`);
    console.error(`[migrate]   address=${err?.address} port=${err?.port}`);
    console.error(`[migrate]   message=${err?.message ?? err}`);
    if (err?.code === 'ECONNREFUSED') {
      console.error('[migrate]   提示: 目标拒绝连接 —— 库地址/端口对，但服务没监听或安全组拦截');
    } else if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
      console.error('[migrate]   提示: DNS 解析失败 —— DATABASE_URL 里的主机名在集群内解析不了（可能要用内网地址/VPC）');
    } else if (err?.code === 'ETIMEDOUT' || /timeout/i.test(err?.message || '')) {
      console.error('[migrate]   提示: 连接超时 —— Pod 到数据库网络不通（跨 VPC / 安全组 / 白名单未放行 Pod 网段）');
    } else if (err?.code === '28P01' || err?.code === '28000') {
      console.error('[migrate]   提示: 认证失败 —— 用户名/密码错误（检查 Secret 里的 DATABASE_URL）');
    } else if (err?.code === '3D000') {
      console.error('[migrate]   提示: 数据库不存在 —— DATABASE_URL 里的库名错误');
    }

    // 排查期可临时设 MIGRATE_IGNORE_ERRORS=1，让 initContainer 不阻塞主容器启动
    if (process.env.MIGRATE_IGNORE_ERRORS === '1') {
      console.warn('[migrate] ⚠️ MIGRATE_IGNORE_ERRORS=1，忽略错误并以 0 退出（仅排查用，勿用于生产）');
      await pool.end().catch(() => undefined);
      process.exit(0);
    }
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] 未捕获异常:', e);
  process.exit(1);
});
