import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentImports1790000002000 implements MigrationInterface {
  name = 'DocumentImports1790000002000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE kh_document_import (
        id BIGINT PRIMARY KEY,
        owner_id BIGINT NOT NULL,
        request_id UUID NOT NULL,
        fingerprint VARCHAR(64) NOT NULL,
        document_id BIGINT NOT NULL UNIQUE,
        file_name VARCHAR(255) NOT NULL,
        file_size BIGINT NOT NULL,
        extension VARCHAR(16) NOT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'processing', 'completed', 'failed')),
        stage VARCHAR(32) NOT NULL DEFAULT 'uploading',
        metadata JSONB NOT NULL DEFAULT '{}',
        checkpoint JSONB,
        warnings JSONB NOT NULL DEFAULT '[]',
        error VARCHAR(1000),
        parser VARCHAR(64),
        attempt INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(owner_id, request_id)
      );
      CREATE INDEX idx_document_import_pending ON kh_document_import(state, created_at);
      CREATE INDEX idx_document_import_owner ON kh_document_import(owner_id, created_at DESC);
      CREATE TABLE kh_document_resource (
        id BIGINT PRIMARY KEY,
        task_id BIGINT NOT NULL REFERENCES kh_document_import(id),
        document_id BIGINT REFERENCES kh_document(id),
        path VARCHAR(1024) NOT NULL,
        driver VARCHAR(16) NOT NULL CHECK (driver IN ('rustfs', 'oss')),
        object_key VARCHAR(512) NOT NULL,
        encryption_key VARCHAR(64) NOT NULL,
        content_type VARCHAR(128) NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id, path)
      );
      CREATE INDEX idx_document_resource_document ON kh_document_resource(document_id);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TABLE kh_document_resource; DROP TABLE kh_document_import;',
    );
  }
}
