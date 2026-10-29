import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/** 文档评论。parent_id 为空是顶层，有值则是一层回复。 */
@Entity('kh_comment')
export class CommentEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 发表时的昵称快照，用户改名后历史评论保持原样 */
  @Column({ name: 'user_name', type: 'varchar', length: 50 })
  userName: string;

  @Column({ type: 'varchar', length: 2000 })
  content: string;

  @Column({
    name: 'parent_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  parentId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
