import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../common/transformers/bigint.transformer.js';

/** 站内通知。type: like / comment / system */
@Entity('kh_notification')
export class NotificationEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 接收人 */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  @Column({ type: 'varchar', length: 20 })
  type: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  content?: string | null;

  @Column({
    name: 'document_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  documentId?: string | null;

  @Column({
    name: 'sender_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  senderId?: string | null;

  @Column({ name: 'sender_name', type: 'varchar', length: 50, nullable: true })
  senderName?: string | null;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
