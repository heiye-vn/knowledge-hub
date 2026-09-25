import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';
import { QueryDocumentDto } from './dto/query-document.dto.js';
import { UploadParseDto } from './dto/upload-parse.dto.js';
import type { ReviewDecisionDto } from './dto/review.dto.js';
import { DocumentEntity } from './entities/document.entity.js';
import {
  canArchive,
  canEditContent,
  canPublishFrom,
  canSaveAsDraft,
  canSubmitReview,
  DocumentStatus,
} from './document-status.js';
import { DocumentContentEntity } from './entities/document-content.entity.js';
import { DocumentReviewService } from './document-review.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { StorageService } from '../storage/storage.service.js';
import type { UploadBytesResult } from '../storage/storage.interface.js';
import { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import { FileParserService } from './parser/file-parser.service.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { KgBuildPublisher } from '../kg/kg-build.publisher.js';
import {
  decodeUploadFilename,
  getExtension,
  titleFromFilename,
} from './parser/utils/markdown.util.js';

/**
 * 内部文件元数据（上传链路写入 kh_document，不暴露给 CreateDocumentDto，
 * 避免客户端伪造 object_key 等存储层字段）
 */
export interface DocumentFileInfo {
  /** 源文件直链 URL */
  fileUrl: string | null;
  /** 对象存储 Key */
  objectKey: string | null;
  /** 原始文件名 */
  fileName: string;
  /** 文件大小（字节，bigint 列统一走 string） */
  fileSize: string;
  /** 扩展名（小写） */
  fileExtension: string;
}

/** 建索引结果（RAG 向量块 / 文档搜索 / KG 图谱三条链路分别给出可用性） */
export interface IndexBuildResult {
  /** RAG 向量块是否写入成功 */
  indexed: boolean;
  /** 写入的块数 */
  chunks: number;
  /** 文档级搜索索引是否写入成功 */
  searchIndexed: boolean;
  /** KG 建图任务是否入队 */
  kgQueued: boolean;
}

/** 审核操作人（从登录态取，客户端不可传入伪造） */
export interface ReviewActor {
  reviewerId: string;
  reviewerName: string;
}

/** 清索引结果 */
export interface IndexCleanupResult {
  /** ES 向量块是否清理成功 */
  vectorsCleaned: boolean;
  /** 文档级搜索索引是否清理成功 */
  searchCleaned: boolean;
  /** KG 图谱清理任务是否入队 */
  kgDeleteQueued: boolean;
}

/**
 * 文档服务（单 PostgreSQL 存储）
 * - 元数据：kh_document
 * - 正文：kh_document_content（1:1，document_id 主键）
 * - 审核流水：kh_document_review（由 DocumentReviewService 负责读写）
 *
 * 🟡 与基线实现的分叉：基线实现用 PG + Mongo 双库（正文在 Mongo），
 * 本项目于 2026-09-20 切换为单 PostgreSQL——Mongo 侧原始规划的
 * chunks / chat_histories 已分别落在 ES / 未启动，只剩正文一个集合，
 * 为它维护一整套独立数据库得不偿失。
 * 直接受益：create 从「先写 Mongo 拿 _id → 写 PG → 失败补偿删 Mongo」
 * 简化为单库事务，双写补偿逻辑整体删除。
 *
 * 状态流转与索引联动全部收敛在本服务：
 * 本服务持有三条索引链路的编排能力，DocumentReviewService 只管审核流水表，
 * 依赖保持单向（本服务 → 审核服务），避免循环依赖。
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    /** Postgres 实体管理器 */
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly fileParserService: FileParserService,
    private readonly storage: StorageService,
    private readonly ragOrchestrator: RagOrchestrator,
    /** 文档级全文搜索索引（ES kh_document）；与 RAG 的 kh_chunk 互补 */
    private readonly searchIndexService: SearchIndexService,
    /** KG 建图队列生产者；KG 单块抽取实测 19~57s，必须异步投递 */
    private readonly kgBuildPublisher: KgBuildPublisher,
    /** 发布审核：审核开关判定 + 审核流水读写 */
    private readonly reviewService: DocumentReviewService,
  ) {}

  /**
   * 创建文档
   * 流程：生成雪花 ID → 单事务内写 kh_document + kh_document_content
   *
   * 双库时代这里是「先写 Mongo 拿 _id → 写 PG → 失败补偿删 Mongo」；
   * 切单 PostgreSQL 后两表同库同事务，要么全成要么全无，补偿逻辑整体删除。
   *
   * 状态约束：只允许「草稿」或（免审模式下的）「已发布」——
   * 待审核必须由 publish / submit 发起（要留审核流水），归档是终态，都不能凭空创建。
   *
   * @param fileInfo 内部参数：上传链路传入的源文件元数据（在线创建时缺省）
   * @param actor 当前登录用户：authorId / createBy 未显式传入时自动落到操作人
   */
  async create(
    dto: CreateDocumentDto,
    fileInfo?: DocumentFileInfo,
    actor?: AuthUser,
  ) {
    const requestedStatus = dto.status ?? DocumentStatus.Draft;
    if (
      requestedStatus !== DocumentStatus.Draft &&
      requestedStatus !== DocumentStatus.Published
    ) {
      throw new BadRequestException('创建文档仅允许草稿或已发布状态');
    }
    if (
      requestedStatus === DocumentStatus.Published &&
      this.reviewService.isRequireApproval()
    ) {
      throw new BadRequestException('开启审核时请先创建草稿，再提交发布/审核');
    }

    const id = nextSnowflakeId();
    const wordCount = this.countWords(dto.content);
    const status = requestedStatus;
    // 未传 summary 时，从正文截取预览作为 contentSummary
    const contentSummary = dto.summary ?? this.buildContentSummary(dto.content);

    const saved = await this.em.transaction(async (tx) => {
      const doc = tx.create(DocumentEntity, {
        id,
        title: dto.title,
        summary: dto.summary,
        categoryId: dto.categoryId,
        teamId: dto.teamId,
        authorId: dto.authorId ?? actor?.userId ?? null,
        coverImage: dto.coverImage,
        tags: dto.tags,
        status,
        remark: dto.remark,
        isPublic: dto.isPublic ?? false,
        wordCount,
        // 源文件元数据（在线创建时为 null）
        fileUrl: fileInfo?.fileUrl ?? null,
        objectKey: fileInfo?.objectKey ?? null,
        fileName: fileInfo?.fileName ?? null,
        fileSize: fileInfo?.fileSize ?? null,
        fileExtension: fileInfo?.fileExtension ?? null,
        // 创建即发布时，记录发布时间
        publishTime: status === DocumentStatus.Published ? new Date() : null,
        createBy: dto.createBy ?? actor?.userId ?? null,
        updateBy: dto.createBy ?? actor?.userId ?? null,
        deleted: false,
      });
      const savedDoc = await tx.save(doc);

      const content = tx.create(DocumentContentEntity, {
        documentId: id,
        content: dto.content,
        contentLength: dto.content.length,
        contentSummary,
        version: 1,
        deleted: false,
      });
      await tx.save(content);

      return savedDoc;
    });

    // 免审模式下创建即发布，同样要建索引（Published 是索引写入的唯一入口）
    if (status === DocumentStatus.Published) {
      await this.buildIndexes(saved, dto.content);
    }

    return { ...saved, content: dto.content };
  }

  /**
   * 分页查询文档列表（只返回 Postgres 元数据，不含正文）
   * 支持按标题模糊、分类 / 团队 / 作者 / 状态筛选
   */
  async findAll(query: QueryDocumentDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    // 默认排除已软删记录
    const qb = this.em
      .createQueryBuilder(DocumentEntity, 'doc')
      .where('doc.deleted = :deleted', { deleted: false });

    // 标题模糊匹配（不区分大小写）
    if (query.title) {
      qb.andWhere('doc.title ILIKE :title', { title: `%${query.title}%` });
    }
    if (query.categoryId) {
      qb.andWhere('doc.category_id = :categoryId', {
        categoryId: query.categoryId,
      });
    }
    if (query.teamId) {
      qb.andWhere('doc.team_id = :teamId', { teamId: query.teamId });
    }
    if (query.authorId) {
      qb.andWhere('doc.author_id = :authorId', { authorId: query.authorId });
    }
    if (query.status !== undefined) {
      qb.andWhere('doc.status = :status', { status: query.status });
    }

    // 按创建时间倒序，再分页
    qb.orderBy('doc.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();

    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  /**
   * 查询文档详情
   * @param withContent 是否附带正文（kh_document_content），默认 true
   */
  async findOne(id: string, withContent = true) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    if (!withContent) {
      return doc;
    }

    return {
      ...doc,
      content: await this.loadContent(id),
    };
  }

  /** 按 documentId 读取未删除正文；内容行缺失时返回空串（沿用 Mongo 时代的容错语义） */
  private async loadContent(documentId: string): Promise<string> {
    const row = await this.em.findOne(DocumentContentEntity, {
      where: { documentId, deleted: false },
    });
    return row?.content ?? '';
  }

  /**
   * 更新文档
   * - 有 content：更新 kh_document_content 正文，并递增 version
   * - 仅改 summary：同步更新内容表 contentSummary
   * - 其余字段只更新 Postgres 元数据
   *
   * 状态相关约束：
   * - 待审核文档禁止改正文 / 标题（否则审核通过的内容与提交时不是同一份）
   * - PATCH 不允许改 status，状态一律走 publish / archive / save-draft / 审核接口
   *   （这些接口才带索引联动，直接改 status 会留下「已发布但无索引」的脏状态）
   *
   * @param actor 当前登录用户：updateBy 未显式传入时自动落到操作人
   */
  async update(id: string, dto: UpdateDocumentDto, actor?: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    if (!canEditContent(doc.status)) {
      throw new BadRequestException(
        doc.status === DocumentStatus.PendingReview
          ? '审核中的文档不可编辑'
          : '当前文档状态不允许编辑',
      );
    }
    if (dto.status !== undefined && dto.status !== doc.status) {
      throw new BadRequestException(
        '请使用 publish / archive / save-draft / 审核接口变更文档状态',
      );
    }

    const oldStatus = doc.status;
    let newContent: string | undefined;

    // —— 正文变更 ——
    if (dto.content !== undefined) {
      newContent = dto.content;
      const contentSummary =
        dto.summary ?? this.buildContentSummary(dto.content);
      const contentRow = await this.em.findOne(DocumentContentEntity, {
        where: { documentId: id, deleted: false },
      });
      if (!contentRow) {
        throw new BadRequestException(
          `Document content ${id} not found`,
        );
      }
      contentRow.content = dto.content;
      contentRow.contentLength = dto.content.length;
      contentRow.contentSummary = contentSummary;
      contentRow.version += 1; // 版本号 +1
      await this.em.save(contentRow);
      doc.wordCount = this.countWords(dto.content);
    } else if (dto.summary !== undefined) {
      // 只改摘要时，同步内容表预览字段（update 不走生命周期钩子，手动带 updatedAt）
      await this.em.update(
        DocumentContentEntity,
        { documentId: id },
        { contentSummary: dto.summary, updatedAt: new Date() },
      );
    }

    // —— 元数据字段（有传才覆盖）——
    if (dto.title !== undefined) doc.title = dto.title;
    if (dto.summary !== undefined) doc.summary = dto.summary;
    if (dto.categoryId !== undefined) doc.categoryId = dto.categoryId;
    if (dto.teamId !== undefined) doc.teamId = dto.teamId;
    if (dto.authorId !== undefined) doc.authorId = dto.authorId;
    if (dto.coverImage !== undefined) doc.coverImage = dto.coverImage;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.remark !== undefined) doc.remark = dto.remark;
    if (dto.isPublic !== undefined) doc.isPublic = dto.isPublic;
    if (dto.updateBy !== undefined) doc.updateBy = dto.updateBy;
    else if (actor?.userId) doc.updateBy = actor.userId;

    const saved = await this.em.save(doc);
    const finalContent = newContent ?? (await this.loadContent(id));

    // 已发布文档改正文后的索引同步：
    // 免审模式直接重建；需审模式下保持旧索引不动，等 submit 时清、审核通过时重建
    // ——避免「改了正文但审核还没过」的窗口期里，新内容已经可被检索到。
    if (
      newContent !== undefined &&
      oldStatus === DocumentStatus.Published &&
      !this.reviewService.isRequireApproval()
    ) {
      await this.buildIndexes(saved, finalContent);
    }

    return { ...saved, content: finalContent };
  }

  /**
   * 发布文档
   * - 需审核（DOCUMENT_REQUIRE_APPROVAL，默认）：草稿 / 已发布 → 待审核，不建索引
   * - 免审：草稿 / 已发布 → 已发布，并建三条索引
   *
   * 🟢 与基线实现的差异：基线实现把已归档也放进可发布集合，且需审模式下会漏到
   * 「免审直接发布」分支 —— 归档文档能绕过审核直接上线。本项目把归档定为终态，
   * 两个模式下都拒绝，从源头堵住这个后门。
   */
  async publish(id: string) {
    const doc = await this.findActive(id);

    if (doc.status === DocumentStatus.PendingReview) {
      throw new BadRequestException('文档审核中，请等待审核结果');
    }
    if (!canPublishFrom(doc.status)) {
      throw new BadRequestException(
        doc.status === DocumentStatus.Archived
          ? '已归档文档不允许重新发布'
          : '当前文档状态不允许发布',
      );
    }

    if (this.reviewService.isRequireApproval()) {
      return this.submitForReview(id);
    }

    return this.markPublishedAndIndex(doc);
  }

  /**
   * 提交审核：草稿 / 已发布 → 待审核
   * 来自已发布时先清索引——审核期间文档不该继续被检索到
   */
  async submitForReview(id: string) {
    const doc = await this.findActive(id);
    if (!canSubmitReview(doc.status)) {
      throw new BadRequestException('只有草稿或已发布状态的文档才能提交审核');
    }

    const beforeStatus = doc.status;
    const review = await this.reviewService.createPendingReview(
      doc.id,
      beforeStatus,
    );

    doc.status = DocumentStatus.PendingReview;
    const saved = await this.em.save(doc);

    // 原为已发布：先把索引清掉，审核通过后再重建
    const cleanup =
      beforeStatus === DocumentStatus.Published
        ? await this.cleanupIndexes(id)
        : null;

    this.logger.log(
      `文档已提交审核：documentId=${id}, reviewId=${review.id}, beforeStatus=${beforeStatus}`,
    );

    return {
      id: saved.id,
      status: saved.status,
      reviewId: review.id,
      pendingApproval: true,
      indexesCleaned: cleanup,
    };
  }

  /**
   * 审核通过：待审核 → 已发布，并建三条索引
   *
   * 审核流水与文档状态在同一个 PG 事务里提交（同库，可原子）；
   * 索引构建放在事务外——ES / Neo4j 无法与 PG 共享事务，
   * 且索引失败时文档已是 Published，可用 POST /rag/reindex 重建（该接口扫的就是已发布文档）。
   */
  async approveReview(taskId: string, dto: ReviewDecisionDto = {}, actor: ReviewActor) {
    const { review, doc } = await this.em.transaction(async (tx) => {
      const approved = await this.reviewService.approve(
        taskId,
        actor.reviewerId,
        actor.reviewerName,
        dto.reviewComment,
        tx,
      );

      const target = await tx.findOne(DocumentEntity, {
        where: { id: approved.documentId, deleted: false },
      });
      if (!target) {
        throw new NotFoundException(`Document ${approved.documentId} not found`);
      }

      target.status = DocumentStatus.Published;
      target.publishTime = new Date();
      const saved = await tx.save(target);
      return { review: approved, doc: saved };
    });

    const indexes = await this.buildIndexes(doc, await this.loadContent(doc.id));

    this.logger.log(
      `审核通过：reviewId=${taskId}, documentId=${doc.id}, indexed=${indexes.indexed}`,
    );

    return {
      id: doc.id,
      status: doc.status,
      publishTime: doc.publishTime,
      reviewId: review.id,
      ...indexes,
    };
  }

  /** 审核驳回：待审核 → 草稿，作者改稿后可再次提交（索引在提审时已清，此处无需再清） */
  async rejectReview(taskId: string, dto: ReviewDecisionDto = {}, actor: ReviewActor) {
    const { review, doc } = await this.em.transaction(async (tx) => {
      const rejected = await this.reviewService.reject(
        taskId,
        dto.reviewComment ?? '',
        actor.reviewerId,
        actor.reviewerName,
        tx,
      );

      const target = await tx.findOne(DocumentEntity, {
        where: { id: rejected.documentId, deleted: false },
      });
      if (!target) {
        throw new NotFoundException(`Document ${rejected.documentId} not found`);
      }

      target.status = DocumentStatus.Draft;
      const saved = await tx.save(target);
      return { review: rejected, doc: saved };
    });

    this.logger.log(`审核驳回：reviewId=${taskId}, documentId=${doc.id}`);

    return {
      id: doc.id,
      status: doc.status,
      reviewId: review.id,
    };
  }

  /** 归档：已发布 → 已归档（终态），清索引但保留正文 */
  async archive(id: string) {
    const doc = await this.findActive(id);
    if (!canArchive(doc.status)) {
      throw new BadRequestException('只有已发布文档可以归档');
    }

    doc.status = DocumentStatus.Archived;
    const saved = await this.em.save(doc);
    const cleanup = await this.cleanupIndexes(id);

    this.logger.log(`文档已归档：documentId=${id}`);

    return { id: saved.id, status: saved.status, ...cleanup };
  }

  /** 下架编辑：已发布 → 草稿，清索引后可改内容再重新提审 / 发布 */
  async saveAsDraft(id: string) {
    const doc = await this.findActive(id);
    if (!canSaveAsDraft(doc.status)) {
      throw new BadRequestException('只有已发布文档可以保存为草稿');
    }

    doc.status = DocumentStatus.Draft;
    const saved = await this.em.save(doc);
    const cleanup = await this.cleanupIndexes(id);

    this.logger.log(`文档已保存为草稿：documentId=${id}`);

    return { id: saved.id, status: saved.status, ...cleanup };
  }

  /** 置为已发布并建索引（publish 的免审路径） */
  private async markPublishedAndIndex(doc: DocumentEntity) {
    if (doc.status !== DocumentStatus.Published) {
      doc.status = DocumentStatus.Published;
      if (!doc.publishTime) doc.publishTime = new Date();
      await this.em.save(doc);
    }

    const indexes = await this.buildIndexes(doc, await this.loadContent(doc.id));

    return {
      id: doc.id,
      status: doc.status,
      publishTime: doc.publishTime,
      ...indexes,
    };
  }

  /**
   * 建三条索引：RAG 向量块 + 文档级搜索 + KG 图谱
   *
   * 阶段一为**同步执行**：RAG 索引失败直接上抛，客户端可重试（管线幂等：先删旧块再覆盖写）。
   *
   * 降级：ES 不可用或未配置 Embedding Key 时，仍完成发布但 `indexed=false`，
   * 不让基础设施故障阻断发布动作。三条链路可用性**分开判定**——
   * 没配 Embedding Key 时文档搜索仍可用，只有语义检索降级。
   */
  private async buildIndexes(
    doc: DocumentEntity,
    content: string,
  ): Promise<IndexBuildResult> {
    const pipelineDoc = this.toPipelineDocument(doc, content);

    let chunks = 0;
    let indexed = false;
    if (this.ragOrchestrator.isAvailable()) {
      const result = await this.ragOrchestrator.indexDocument(pipelineDoc);
      chunks = result.chunks;
      indexed = true;
    } else {
      this.logger.warn(
        `RAG 索引链路不可用，已发布但未建向量索引：documentId=${doc.id}（检查 ELASTICSEARCH_ENABLED / EMBEDDING_API_KEY）`,
      );
    }

    const searchIndexed = await this.indexForSearch(pipelineDoc);

    // KG 建图走异步队列：单块 LLM 抽取实测 19~57s（见 kg/extraction-e2e.spec.ts），
    // 同步会撞网关超时。队列不可用只降级，不阻断发布。
    const kgTaskId = await this.safeEnqueueKgBuild(doc.id);

    return {
      indexed,
      chunks,
      searchIndexed,
      kgQueued: kgTaskId != null,
    };
  }

  /**
   * 清理三条索引（ES 向量块 / 文档搜索 / KG 图谱）
   *
   * 跨系统无事务：任一侧失败只记日志，不阻断状态流转；
   * 返回值把清理结果交给调用方，便于接口层暴露给客户端判断是否要人工兜底。
   */
  private async cleanupIndexes(id: string): Promise<IndexCleanupResult> {
    let vectorsCleaned = false;
    try {
      await this.ragOrchestrator.deleteDocument(id);
      vectorsCleaned = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `清理 ES 向量块失败（检索侧会兜底过滤）：documentId=${id}, ${message}`,
      );
    }

    let searchCleaned = false;
    try {
      await this.searchIndexService.deleteDocument(id);
      searchCleaned = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `清理文档搜索索引失败（检索侧会兜底过滤）：documentId=${id}, ${message}`,
      );
    }

    let kgDeleteQueued = false;
    if (this.kgBuildPublisher.isAvailable()) {
      try {
        kgDeleteQueued =
          (await this.kgBuildPublisher.enqueueDeleteByDocIds([id])) != null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `KG 清理任务入队失败：documentId=${id}, ${message}`,
        );
      }
    }

    return { vectorsCleaned, searchCleaned, kgDeleteQueued };
  }

  /** 投递 KG 建图任务；失败只记日志（建图是派生数据，可用 POST /kg/build 补偿） */
  private async safeEnqueueKgBuild(id: string): Promise<string | null> {
    if (!this.kgBuildPublisher.isAvailable()) {
      this.logger.warn(
        `KG 建图队列不可用，已发布但未排队建图：documentId=${id}（可稍后 POST /kg/build 补偿）`,
      );
      return null;
    }
    try {
      return await this.kgBuildPublisher.enqueueBuildByDocIds([id]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `KG 建图任务入队失败：documentId=${id}, ${message}`,
      );
      return null;
    }
  }

  /**
   * 写文档级搜索索引（ES kh_document）。
   * 失败不阻断发布——ES 与 PG 无法共享事务，索引没写上去还有 `POST /rag/reindex` 兜底。
   */
  private async indexForSearch(pipelineDoc: PipelineDocument): Promise<boolean> {
    if (!this.searchIndexService.isAvailable()) {
      this.logger.warn(
        `搜索索引链路不可用，已发布但未建文档索引：documentId=${pipelineDoc.id}`,
      );
      return false;
    }
    try {
      await this.searchIndexService.indexDocument(pipelineDoc);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `文档搜索索引写入失败（可用 POST /rag/reindex 重建）：documentId=${pipelineDoc.id}, ${message}`,
      );
      return false;
    }
  }

  /** 取未删除文档；不存在时抛 404 */
  private async findActive(id: string): Promise<DocumentEntity> {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    return doc;
  }

  /** Postgres 元数据 + 正文 → RAG 管线统一结构 */
  toPipelineDocument(doc: DocumentEntity, content: string): PipelineDocument {
    return {
      id: doc.id,
      title: doc.title,
      content,
      summary: doc.summary,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      status: doc.status,
      tags: doc.tags,
      isPublic: doc.isPublic,
      publishTime: doc.publishTime,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      viewCount: doc.viewCount,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
    };
  }

  /**
   * 按 ID 批量加载「待索引文档」（PG 元数据 + 正文，单库两表直查）
   *
   * 供重建队列的 Worker 使用。基线实现把这段放在 `PipelineOrchestrator` 内部
   * （`loadDocumentsByIds`），本项目 Orchestrator 只接收已加载的 `PipelineDocument`，
   * 故加载职责留在调用方，保持「编排器不管数据源」的边界。
   *
   * 不存在的文档跳过并记日志，不中断整批。
   */
  async loadForIndex(ids: string[]): Promise<PipelineDocument[]> {
    const result: PipelineDocument[] = [];
    for (const id of ids) {
      const doc = await this.em.findOne(DocumentEntity, {
        where: { id, deleted: false },
      });
      if (!doc) {
        this.logger.warn(`重建跳过：文档不存在或已删除 documentId=${id}`);
        continue;
      }
      result.push(this.toPipelineDocument(doc, await this.loadContent(id)));
    }
    return result;
  }

  /**
   * 查询全部「已发布且未删除」的文档 ID
   *
   * 用于重建入口在未显式指定 ID 时的**全量重索引**
   * —— 典型场景：换 embedding 模型后，旧向量与新查询不在同一向量空间，必须全量重建。
   */
  async findPublishedIds(): Promise<string[]> {
    const rows = await this.em.find(DocumentEntity, {
      where: { deleted: false, status: DocumentStatus.Published },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * 软删除文档
   * kh_document 与 kh_document_content 两侧都将 deleted 置为 true（不物理删正文）
   *
   * 仅已发布文档需要清索引——草稿 / 待审核 / 归档本来就不在索引里，
   * 无条件投递清理消息只会给 ES 和 Neo4j 增加无谓的写放大。
   */
  async remove(id: string) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    doc.deleted = true;
    await this.em.save(doc);
    // update 不走生命周期钩子，手动带 updatedAt
    await this.em.update(
      DocumentContentEntity,
      { documentId: id },
      { deleted: true, updatedAt: new Date() },
    );

    const cleanup =
      doc.status === DocumentStatus.Published
        ? await this.cleanupIndexes(id)
        : { vectorsCleaned: false, searchCleaned: false, kgDeleteQueued: false };

    return { id, deleted: true, ...cleanup };
  }

  /** 上传并解析文件 → 创建草稿文档（authorId/createBy 自动落到当前登录用户） */
  async uploadAndCreateDocument(
    file: Express.Multer.File,
    meta: UploadParseDto = {},
    actor?: AuthUser,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('文件不能为空');
    }

    const originalFilename = decodeUploadFilename(file.originalname);
    const extension = getExtension(originalFilename);

    if (!this.fileParserService.isSupported(extension)) {
      throw new BadRequestException(
        `不支持的文件格式: ${extension}，支持的格式: ${this.fileParserService.supportedList()}`,
      );
    }

    this.logger.log(
      `上传并解析文件：name=${originalFilename}, size=${file.size}, ext=${extension}`,
    );

    let parsedContent: string;
    try {
      parsedContent = await this.fileParserService.parse({
        originalname: originalFilename,
        buffer: file.buffer,
        size: file.size,
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `文件解析失败：name=${originalFilename}, error=${message}`,
      );
      throw new BadRequestException(`文件解析失败: ${message}`);
    }

    let uploadResult: UploadBytesResult | null = null;
    if (this.storage.isEnabled()) {
      try {
        uploadResult = await this.storage.uploadBytes(file.buffer, {
          fileName: originalFilename,
          contentType: file.mimetype || 'application/octet-stream',
          prefix: 'documents',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`原文件上传存储服务失败：${message}`);
        throw new BadRequestException(`原文件上传失败: ${message}`);
      }
    } else {
      this.logger.warn('对象存储未启用，跳过原文件上传');
    }

    const title = titleFromFilename(originalFilename);

    const created = await this.create(
      {
        title,
        content: parsedContent,
        categoryId: meta.categoryId,
        teamId: meta.teamId,
        authorId: meta.authorId,
        tags: meta.tags,
        remark: meta.remark,
        createBy: meta.createBy,
        isPublic: meta.isPublic,
        status: DocumentStatus.Draft,
      },
      {
        // 持久化源文件元数据，供列表/详情展示、重解析与对象清理反查
        fileUrl: uploadResult?.url ?? null,
        objectKey: uploadResult?.key ?? null,
        fileName: originalFilename,
        fileSize: String(file.size),
        fileExtension: extension,
      },
      actor,
    );

    const fileUrl = uploadResult?.url ?? null;

    const previewLen = Math.min(200, parsedContent.length);
    const result = {
      documentId: created.id,
      title,
      fileUrl,
      fileSize: String(file.size),
      fileExtension: extension,
      contentLength: parsedContent.length,
      contentPreview: parsedContent.slice(0, previewLen),
      status: DocumentStatus.Draft,
    };

    this.logger.log(
      `文件解析并创建文档成功：documentId=${created.id}, title=${title}, ext=${extension}, chars=${parsedContent.length}, fileUrl=${fileUrl}`,
    );

    return result;
  }

  /**
   * 从正文截取预览摘要
   * 压缩连续空白后截断到 maxLen，超出则追加省略号
   */
  private buildContentSummary(content: string, maxLen = 200): string {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxLen
      ? trimmed
      : `${trimmed.slice(0, maxLen)}...`;
  }

  /**
   * 统计正文字数（中英混合）
   * - 中日韩汉字：每个字符计 1 字
   * - 英文等拉丁文本：按空白分词，每个单词计 1 字
   */
  private countWords(content: string): number {
    const trimmed = content.trim();
    if (!trimmed) return 0;

    // 匹配所有 CJK 统一汉字（U+4E00–U+9FFF），每个汉字算 1
    const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;

    // 去掉汉字后，剩余按空白切分为英文单词再计数
    const latin = trimmed
      .replace(/[\u4e00-\u9fff]/g, ' ') // 汉字替换为空格，避免与英文粘连
      .trim()
      .split(/\s+/) // 按连续空白分词
      .filter(Boolean).length; // 去掉空串

    return cjk + latin;
  }
}
