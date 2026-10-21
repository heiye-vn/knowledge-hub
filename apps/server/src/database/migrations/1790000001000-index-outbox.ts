import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 索引失败补偿任务表（2026-10 新增）。
 *
 * ES / Neo4j 与 PostgreSQL 无法共享事务，索引写入失败原本只记日志，
 * 留下「已发布但搜不到」的静默缺口。本表承接失败任务的退避重试。
 *
 * 【易错】唯一索引必须带 WHERE 条件（部分索引）：同一文档同一目标允许
 * 留下 succeeded / dead 的历史行，只约束"未完成"的 pending / retry。
 * IndexOutboxService.record 的 ON CONFLICT 依赖这条部分唯一索引。
 */
export class IndexOutbox1790000001000 implements MigrationInterface {
  name = 'IndexOutbox1790000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS kh_index_outbox (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        target VARCHAR(16) NOT NULL,
        operation VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error VARCHAR(1000),
        next_run_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kh_index_outbox_due
        ON kh_index_outbox(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_kh_index_outbox_document_id
        ON kh_index_outbox(document_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kh_index_outbox_pending
        ON kh_index_outbox(document_id, target, operation)
        WHERE status IN ('pending', 'retry');
      COMMENT ON TABLE kh_index_outbox IS '索引失败补偿任务表（ES / Neo4j 异步重试）';
      COMMENT ON COLUMN kh_index_outbox.target IS '目标索引：rag / search / kg / visibility';
      COMMENT ON COLUMN kh_index_outbox.operation IS '操作：upsert / delete / visibility';
      COMMENT ON COLUMN kh_index_outbox.status IS '状态：pending / retry / succeeded / dead';
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS kh_index_outbox;');
  }
}
