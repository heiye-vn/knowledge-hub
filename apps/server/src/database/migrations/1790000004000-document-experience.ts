import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 产品体验模块：分类、评论、点赞、收藏、分享、版本、通知。
 *
 * 全部与 kh_document 同库；分享/通知/版本快照不建外键，避免文档软删后
 * 历史记录被级联清空（与 kh_document_review 的处理保持一致）。
 */
export class DocumentExperience1790000004000 implements MigrationInterface {
  name = 'DocumentExperience1790000004000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS kh_category (
        id BIGINT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        parent_id BIGINT NOT NULL DEFAULT 0,
        sort INT NOT NULL DEFAULT 0,
        description VARCHAR(500),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        deleted BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_kh_category_parent
        ON kh_category(parent_id);

      CREATE TABLE IF NOT EXISTS kh_comment (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        user_name VARCHAR(50) NOT NULL,
        content VARCHAR(2000) NOT NULL,
        parent_id BIGINT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        deleted BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_kh_comment_document_created
        ON kh_comment(document_id, created_at);

      CREATE TABLE IF NOT EXISTS kh_document_like (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_kh_document_like_doc_user UNIQUE (document_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS kh_document_favorite (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_kh_document_favorite_doc_user UNIQUE (document_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_kh_document_favorite_user_created
        ON kh_document_favorite(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS kh_document_share (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        token VARCHAR(64) NOT NULL UNIQUE,
        require_password BOOLEAN NOT NULL DEFAULT FALSE,
        password_hash VARCHAR(255),
        expire_at TIMESTAMP,
        create_by BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        revoked BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_kh_document_share_document
        ON kh_document_share(document_id);

      CREATE TABLE IF NOT EXISTS kh_document_version (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        version INT NOT NULL,
        title VARCHAR NOT NULL,
        content TEXT NOT NULL,
        summary VARCHAR,
        create_by BIGINT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_kh_document_version_doc_version UNIQUE (document_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_kh_document_version_document
        ON kh_document_version(document_id, version DESC);

      CREATE TABLE IF NOT EXISTS kh_notification (
        id BIGINT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        type VARCHAR(20) NOT NULL,
        title VARCHAR(100) NOT NULL,
        content VARCHAR(2000),
        document_id BIGINT,
        sender_id BIGINT,
        sender_name VARCHAR(50),
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kh_notification_user_created
        ON kh_notification(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_kh_notification_unread
        ON kh_notification(user_id) WHERE is_read = FALSE;
    `);

    // 分类管理权限：管理员由 PermissionsGuard 短路，普通角色默认不授予，
    // 需要时可在角色权限页显式分配。
    await runner.query(`
      INSERT INTO kh_permission
        (id, parent_id, permission_name, permission_code, permission_type, sort)
      SELECT 4000000000000000016, 4000000000000000002, '分类管理', 'document:category', 2, 6
      WHERE NOT EXISTS (
        SELECT 1 FROM kh_permission
        WHERE permission_code = 'document:category' AND deleted = FALSE
      );
    `);

    await runner.query(`
      INSERT INTO kh_category (id, name, parent_id, sort, description) VALUES
        (7000000000000000001, '制度规范', 0, 1, '公司制度与流程'),
        (7000000000000000002, '技术文档', 0, 2, '设计、接口与实现说明'),
        (7000000000000000003, '操作手册', 0, 3, '操作步骤与排障')
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DELETE FROM kh_role_permission
      WHERE permission_id = 4000000000000000016;
      DELETE FROM kh_user_permission
      WHERE permission_id = 4000000000000000016;
      DELETE FROM kh_permission
      WHERE permission_code = 'document:category';

      DROP TABLE IF EXISTS kh_notification;
      DROP TABLE IF EXISTS kh_document_version;
      DROP TABLE IF EXISTS kh_document_share;
      DROP TABLE IF EXISTS kh_document_favorite;
      DROP TABLE IF EXISTS kh_document_like;
      DROP TABLE IF EXISTS kh_comment;
      DROP TABLE IF EXISTS kh_category;
    `);
  }
}
