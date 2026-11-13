import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js'

/**
 * 文档浏览埋点（首页「访问趋势」数据源）
 *
 * 每次成功读取文档详情写一行，fire-and-forget——埋点失败不影响读接口。
 * 不建外键：文档软删后历史访问量仍需保留。
 */
@Entity('kh_doc_view_log')
export class DocumentViewLogEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string

  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date
}
