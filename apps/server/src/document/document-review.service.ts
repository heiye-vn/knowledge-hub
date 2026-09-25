import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, IsNull } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import type { DocumentStatus } from './document-status.js';
import {
  DocumentReviewEntity,
  ReviewResult,
} from './entities/document-review.entity.js';
import type { QueryReviewTasksDto } from './dto/review.dto.js';

/**
 * 文档审核记录服务（只负责 kh_document_review 这一张表）
 *
 * 职责边界：**不碰文档状态、不碰索引**。
 * 状态迁移与索引联动统一由 DocumentService 编排（单向依赖：DocumentService → 本服务），
 * 这样两边都要读写文档表时不会出现循环依赖，也避免同一份状态变更逻辑散落两处。
 *
 * 审核开关：环境变量 DOCUMENT_REQUIRE_APPROVAL，默认 true（false 时 publish 直接发布）。
 */
@Injectable()
export class DocumentReviewService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly config: ConfigService,
  ) {}

  /** 是否开启发布审核（默认 true；DOCUMENT_REQUIRE_APPROVAL=false 时免审） */
  isRequireApproval(): boolean {
    return (
      this.config.get<string>('DOCUMENT_REQUIRE_APPROVAL', 'true') !== 'false'
    );
  }

  /**
   * 插入一条待审记录（review_result 留空表示待审）
   *
   * 🔴 修基线实现缺陷：其「同一文档只能有一条待审」只在应用层 findOne 判空，
   * 并发提审会插进两条。本项目加部分唯一索引 uq_kh_document_review_pending
   * 由数据库兜底，并把唯一冲突翻译成 400 业务异常。
   */
  async createPendingReview(
    documentId: string,
    beforeStatus: DocumentStatus,
    tx?: EntityManager,
  ): Promise<DocumentReviewEntity> {
    const manager = tx ?? this.em;
    const review = manager.create(DocumentReviewEntity, {
      id: nextSnowflakeId(),
      documentId,
      beforeStatus,
    });

    try {
      return await manager.save(review);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('该文档已有待审核任务');
      }
      throw err;
    }
  }

  /** 审核通过：回填审核人与意见（文档状态与索引由调用方负责） */
  async approve(
    reviewId: string,
    reviewerId: string,
    reviewerName: string,
    reviewComment?: string,
    tx?: EntityManager,
  ): Promise<DocumentReviewEntity> {
    const review = await this.loadPendingReview(reviewId, tx);

    review.reviewResult = ReviewResult.Approved;
    review.reviewerId = reviewerId;
    review.reviewerName = reviewerName;
    review.reviewComment = reviewComment?.trim() || null;
    review.reviewedAt = new Date();

    return (tx ?? this.em).save(review);
  }

  /** 审核驳回：意见必填（作者要据此改稿） */
  async reject(
    reviewId: string,
    reviewComment: string,
    reviewerId: string,
    reviewerName: string,
    tx?: EntityManager,
  ): Promise<DocumentReviewEntity> {
    if (!reviewComment?.trim()) {
      throw new BadRequestException('驳回意见不能为空');
    }

    const review = await this.loadPendingReview(reviewId, tx);

    review.reviewResult = ReviewResult.Rejected;
    review.reviewerId = reviewerId;
    review.reviewerName = reviewerName;
    review.reviewComment = reviewComment.trim();
    review.reviewedAt = new Date();

    return (tx ?? this.em).save(review);
  }

  /** 待办 / 已通过 / 已驳回列表 */
  async listTasks(query: QueryReviewTasksDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const qb = this.em.createQueryBuilder(DocumentReviewEntity, 'r');
    if (!query.status || query.status === 'pending') {
      qb.andWhere('r.review_result IS NULL');
    } else if (query.status === 'approved') {
      qb.andWhere('r.review_result = :result', {
        result: ReviewResult.Approved,
      });
    } else {
      qb.andWhere('r.review_result = :result', {
        result: ReviewResult.Rejected,
      });
    }

    qb.orderBy('r.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /** 待审数量（工作台角标） */
  async getPendingCount(): Promise<number> {
    return this.em.count(DocumentReviewEntity, {
      where: { reviewResult: IsNull() },
    });
  }

  /** 该文档当前待审任务（无则 null） */
  async getCurrentReview(documentId: string) {
    return this.em.findOne(DocumentReviewEntity, {
      where: { documentId, reviewResult: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** 该文档全部审核记录（含已通过、已驳回），按提交时间倒序 */
  async getReviewHistory(documentId: string) {
    return this.em.find(DocumentReviewEntity, {
      where: { documentId },
      order: { createdAt: 'DESC' },
    });
  }

  /** 取一条「仍是待审」的记录；不存在或已结案都拒绝 */
  async loadPendingReview(
    reviewId: string,
    tx?: EntityManager,
  ): Promise<DocumentReviewEntity> {
    const review = await (tx ?? this.em).findOne(DocumentReviewEntity, {
      where: { id: reviewId },
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found`);
    }
    if (review.reviewResult != null) {
      throw new BadRequestException('该审核任务已处理');
    }
    return review;
  }
}

/** PostgreSQL 唯一约束冲突（23505）；命中部分唯一索引即「已有待审」 */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}
