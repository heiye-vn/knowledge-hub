import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';
import type { UploadParseDto } from '../dto/upload-parse.dto.js';
import type { MineruCheckpoint } from '../parser/parse-result.js';

export type ImportState = 'queued' | 'processing' | 'completed' | 'failed';

@Entity('kh_document_import')
export class DocumentImportEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ name: 'owner_id', type: 'bigint', transformer: bigintTransformer })
  ownerId: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId: string;

  @Column({ type: 'varchar', length: 64 })
  fingerprint: string;

  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'file_size', type: 'bigint', transformer: bigintTransformer })
  fileSize: string;

  @Column({ type: 'varchar', length: 16 })
  extension: string;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  state: ImportState;

  @Column({ type: 'varchar', length: 32, default: 'uploading' })
  stage: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Omit<UploadParseDto, 'requestId'>;

  @Column({ type: 'jsonb', nullable: true })
  checkpoint: MineruCheckpoint | null;

  @Column({ type: 'jsonb', default: [] })
  warnings: string[];

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  parser: string | null;

  @Column({ type: 'integer', default: 0 })
  attempt: number;

  /** 用户从列表隐藏的记录；只影响展示，不删除任务、文档与资源。 */
  @Column({ type: 'boolean', default: false })
  dismissed: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
