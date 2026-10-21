import type { ConfigService } from '@nestjs/config';
import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities.js';
import { MIGRATIONS } from './migrations/index.js';

/**
 * 共享 TypeORM 连接配置：运行时（AppModule）与迁移 CLI（migrate.ts）共用。
 *
 * 【为什么抽出来】此前连接参数写死在 app.module.ts，迁移 CLI 只能再抄一份，
 * 两边默认值一旦不一致就会出现「应用连 A 库、迁移改 B 库」的隐蔽故障。
 *
 * @param config Nest ConfigService；CLI 场景不传，直接读 process.env
 */
export function buildTypeOrmOptions(
  config?: ConfigService,
): DataSourceOptions {
  const get = (key: string, fallback: string): string =>
    config?.get<string>(key) ?? process.env[key] ?? fallback;

  return {
    type: 'postgres',
    host: get('POSTGRES_HOST', 'localhost'),
    port: Number(get('POSTGRES_PORT', '5432')),
    username: get('POSTGRES_USER', 'user'),
    password: get('POSTGRES_PASSWORD', '123456'),
    database: get('POSTGRES_DB', 'knowledge_hub'),
    entities: ENTITIES,
    migrations: MIGRATIONS,
    // 表结构只由迁移管理，禁止 synchronize 自动改表
    synchronize: false,
    // 默认 false：部署前显式执行 migration:run，避免多实例启动时并发改表
    migrationsRun: get('DB_MIGRATIONS_RUN', 'false') === 'true',
  };
}
