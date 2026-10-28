import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentImportDismiss1790000003000 implements MigrationInterface {
  name = 'DocumentImportDismiss1790000003000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE kh_document_import
        ADD COLUMN dismissed BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX idx_document_import_owner_visible
        ON kh_document_import(owner_id, dismissed, created_at DESC);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP INDEX idx_document_import_owner_visible;
      ALTER TABLE kh_document_import DROP COLUMN dismissed;
    `);
  }
}
