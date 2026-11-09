import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { ChatMemoryMirror1790000005000 } from './1790000005000-chat-memory-mirror.js';

/**
 * 迁移的离线校验：断言 SQL 结构而不连数据库。
 * 真实执行仍需 `pnpm docker:up && pnpm migration:run`。
 */
describe('ChatMemoryMirror1790000005000（迁移 SQL 结构）', () => {
  it('up 建表并补齐唯一键与三个查询索引', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    const migration = new ChatMemoryMirror1790000005000();

    await migration.up({ query } as unknown as QueryRunner);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS kh_ai_memory');
    expect(sql).toMatch(/memory_id VARCHAR\(64\) NOT NULL/);
    expect(sql).toMatch(/user_id BIGINT NOT NULL/);
    expect(sql).toContain("status VARCHAR(16) NOT NULL DEFAULT 'active'");
    expect(sql).toContain('uk_kh_ai_memory_memory_id');
    expect(sql).toContain('idx_kh_ai_memory_user_layer');
    expect(sql).toContain('idx_kh_ai_memory_user_status');
    expect(sql).toContain('idx_kh_ai_memory_session');
  });

  it('down 先删索引再删表', async () => {
    const query = vi.fn(async (_sql: string) => undefined);
    const migration = new ChatMemoryMirror1790000005000();

    await migration.down({ query } as unknown as QueryRunner);
    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');

    expect(sql).toContain('DROP TABLE IF EXISTS kh_ai_memory');
    expect(sql.indexOf('DROP INDEX')).toBeLessThan(
      sql.indexOf('DROP TABLE'),
    );
  });
});
