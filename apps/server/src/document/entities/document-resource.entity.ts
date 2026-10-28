import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';
import type { StorageDriverType } from '../../storage/storage.service.js';

@Entity('kh_document_resource')
export class DocumentResourceEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ name: 'task_id', type: 'bigint', transformer: bigintTransformer })
  taskId: string;

  @Column({
    name: 'document_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  documentId: string | null;

  @Column({ type: 'varchar', length: 1024 })
  path: string;

  @Column({ type: 'varchar', length: 16 })
  driver: StorageDriverType;

  @Column({ name: 'object_key', type: 'varchar', length: 512 })
  objectKey: string;

  @Column({ name: 'encryption_key', type: 'varchar', length: 64 })
  encryptionKey: string;

  @Column({ name: 'content_type', type: 'varchar', length: 128 })
  contentType: string;

  @Column({ name: 'byte_length', type: 'integer' })
  byteLength: number;

  @Column({ type: 'boolean', default: false })
  ready: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
