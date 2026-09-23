import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/** 文档状态 */
export enum DocumentStatus {
  /** 草稿 */
  Draft = 0,
  /** 已发布 */
  Published = 1,
  /** 已归档：不会作为知识被检索 */
  Archived = 2,
}

/** 文档元数据（PostgreSQL kh_document） */
@Entity('kh_document')
export class DocumentEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 标题 */
  @Column({ type: 'varchar' })
  title: string;

  /** 摘要 */
  @Column({ type: 'varchar', nullable: true })
  summary?: string | null;

  /** 分类 ID */
  @Column({
    name: 'category_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  categoryId?: string | null;

  /** 团队 ID */
  @Column({
    name: 'team_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  teamId?: string | null;

  /** 作者 ID */
  @Column({
    name: 'author_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  authorId?: string | null;

  /** 封面图 URL */
  @Column({ name: 'cover_image', type: 'varchar', nullable: true })
  coverImage?: string | null;

  /** 标签（逗号分隔） */
  @Column({ type: 'varchar', nullable: true })
  tags?: string | null;

  /** 状态：0 草稿 / 1 已发布 / 2 已归档 */
  @Column({ type: 'smallint', default: DocumentStatus.Draft })
  status: DocumentStatus;

  /** 备注 */
  @Column({ type: 'varchar', nullable: true })
  remark?: string | null;

  /** 浏览数 */
  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount: number;

  /** 点赞数 */
  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount: number;

  /** 评论数 */
  @Column({ name: 'comment_count', type: 'int', default: 0 })
  commentCount: number;

  /** 收藏数 */
  @Column({ name: 'favourite_count', type: 'int', default: 0 })
  favouriteCount: number;

  /** 字数 */
  @Column({ name: 'word_count', type: 'int', default: 0 })
  wordCount: number;

  /** 发布时间 */
  @Column({ name: 'publish_time', type: 'timestamp', nullable: true })
  publishTime?: Date | null;

  /** 是否公开 */
  @Column({ name: 'is_public', type: 'boolean', default: false })
  isPublic: boolean;

  /** 源文件直链 URL（bucket 匿名只读时可直访；预签名模式下仅参考） */
  @Column({ name: 'file_url', type: 'varchar', nullable: true })
  fileUrl?: string | null;

  /** RustFS 对象 Key（删除清理与重解析的依据） */
  @Column({ name: 'object_key', type: 'varchar', nullable: true })
  objectKey?: string | null;

  /** 上传时的原始文件名 */
  @Column({ name: 'file_name', type: 'varchar', nullable: true })
  fileName?: string | null;

  /** 源文件大小（字节） */
  @Column({ name: 'file_size', type: 'bigint', nullable: true, transformer: bigintTransformer })
  fileSize?: string | null;

  /** 源文件扩展名（小写，不含点） */
  @Column({ name: 'file_extension', type: 'varchar', nullable: true })
  fileExtension?: string | null;

  /** 创建时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  /** 更新时间 */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** 创建人 ID */
  @Column({
    name: 'create_by',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  createBy?: string | null;

  /** 更新人 ID */
  @Column({
    name: 'update_by',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  updateBy?: string | null;

  /** 逻辑删除 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
