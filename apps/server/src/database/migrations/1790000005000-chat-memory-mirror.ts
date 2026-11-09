import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 长期记忆本地镜像（feat-v22）。
 *
 * memory_id 唯一索引保证 upsert 幂等；user_id + layer / status 支撑分层计数
 * 与归档扫描。不建外键：会话删除后仍需保留审计痕迹，清理由应用层显式执行
 * （ChatMemoryMirrorService.removeSession），与 kh_document_review 的处理一致。
 */
export class ChatMemoryMirror1790000005000 implements MigrationInterface {
  name = 'ChatMemoryMirror1790000005000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS kh_ai_memory (
        id BIGINT PRIMARY KEY,
        memory_id VARCHAR(64) NOT NULL,
        user_id BIGINT NOT NULL,
        session_id BIGINT,
        layer VARCHAR(16) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        source_created_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_ai_memory_memory_id
        ON kh_ai_memory(memory_id);
      CREATE INDEX IF NOT EXISTS idx_kh_ai_memory_user_layer
        ON kh_ai_memory(user_id, layer);
      CREATE INDEX IF NOT EXISTS idx_kh_ai_memory_user_status
        ON kh_ai_memory(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_kh_ai_memory_session
        ON kh_ai_memory(session_id);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP INDEX IF EXISTS idx_kh_ai_memory_session;
      DROP INDEX IF EXISTS idx_kh_ai_memory_user_status;
      DROP INDEX IF EXISTS idx_kh_ai_memory_user_layer;
      DROP INDEX IF EXISTS uk_kh_ai_memory_memory_id;
      DROP TABLE IF EXISTS kh_ai_memory;
    `);
  }
}
