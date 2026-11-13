import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 可观测性两张表：文档浏览埋点（kh_doc_view_log）与审计日志（kh_audit_log）。
 *
 * 均不建外键——文档/用户软删后历史统计与审计记录必须保留，
 * 这与 kh_document_review / kh_document_version 的处理保持一致。
 */
export class Observability1790000006000 implements MigrationInterface {
  name = 'Observability1790000006000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS kh_doc_view_log (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kh_doc_view_log_created
        ON kh_doc_view_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_kh_doc_view_log_document
        ON kh_doc_view_log(document_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS kh_audit_log (
        id BIGINT PRIMARY KEY,
        actor_id BIGINT NOT NULL,
        actor_name VARCHAR(50) NOT NULL,
        action VARCHAR(30) NOT NULL,
        target_type VARCHAR(20) NOT NULL,
        target_id BIGINT,
        target_name VARCHAR(200),
        detail VARCHAR(500),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kh_audit_log_created
        ON kh_audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_kh_audit_log_actor
        ON kh_audit_log(actor_id, created_at DESC);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP TABLE IF EXISTS kh_audit_log;
      DROP TABLE IF EXISTS kh_doc_view_log;
    `);
  }
}
