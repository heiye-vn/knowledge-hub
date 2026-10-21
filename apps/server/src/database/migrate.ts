import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { MIGRATIONS } from './migrations/index.js';
import { buildTypeOrmOptions } from './typeorm.options.js';

/**
 * 迁移 CLI：`pnpm migration:run | migration:revert | migration:show`
 *
 * 【为什么不用 typeorm CLI】项目是原生 ESM，typeorm CLI 需要额外的
 * ts-node / data-source 配置且对 ESM 支持不稳；这里直接复用
 * buildTypeOrmOptions + MIGRATIONS，编译后由 node 执行，零额外依赖。
 *
 * 【幂等约定】
 * - 空库：baseline 迁移负责建全部表并写入预置数据；
 * - 存量库（已由 init 脚本建表）：baseline 迁移内部检测到 kh_document
 *   已存在即直接返回，TypeORM 只登记该迁移为已执行，不重复改表。
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  loadDotEnv();

  const dataSource = new DataSource(buildTypeOrmOptions());
  await dataSource.initialize();

  try {
    switch (command) {
      case 'run':
        await run(dataSource);
        return;
      case 'revert':
        await revert(dataSource);
        return;
      case 'show':
        await show(dataSource);
        return;
      default:
        throw new Error(
          `未知命令：${command}（可用：run / revert / show）`,
        );
    }
  } finally {
    await dataSource.destroy();
  }
}

async function run(dataSource: DataSource): Promise<void> {
  const executed = await dataSource.runMigrations({ transaction: 'each' });
  if (!executed.length) {
    console.log('没有待执行的迁移，数据库已是最新。');
    return;
  }
  for (const migration of executed) {
    console.log(`✓ ${migration.name}`);
  }
  console.log(`迁移完成：共执行 ${executed.length} 个。`);
}

async function revert(dataSource: DataSource): Promise<void> {
  await dataSource.undoLastMigration({ transaction: 'each' });
  console.log('已回滚最后一个迁移。');
}

async function show(dataSource: DataSource): Promise<void> {
  // 迁移表可能尚不存在（全新库）——查询失败按"全部未执行"处理
  const rows = (await dataSource
    .query('SELECT name FROM migrations')
    .catch(() => [])) as Array<{ name: string }>;
  const applied = new Set(rows.map((row) => row.name));

  let executed = 0;
  let pending = 0;
  for (const Migration of MIGRATIONS) {
    const name = new Migration().name ?? Migration.name;
    if (applied.has(name)) {
      executed += 1;
      console.log(`  ✓ ${name}`);
    } else {
      pending += 1;
      console.log(`  · ${name}（待执行）`);
    }
  }
  console.log(`共 ${executed + pending} 个迁移：已执行 ${executed}，待执行 ${pending}。`);
}

/**
 * 读取当前工作目录下的 .env（CLI 场景没有 ConfigModule）。
 * 已存在的环境变量优先，便于 CI / 容器用真实环境变量覆盖。
 */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`迁移失败：${detail}`);
  process.exitCode = 1;
});
