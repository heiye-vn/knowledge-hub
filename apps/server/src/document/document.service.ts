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
import { DocumentEntity, DocumentStatus } from './entities/document.entity.js';
import { DocumentContentEntity } from './entities/document-content.entity.js';
import { RustfsService, UploadBytesResult } from '../storage/rustfs.service.js';
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
  /** RustFS 对象 Key */
  objectKey: string | null;
  /** 原始文件名 */
  fileName: string;
  /** 文件大小（字节，bigint 列统一走 string） */
  fileSize: string;
  /** 扩展名（小写） */
  fileExtension: string;
}

/**
 * 文档服务（单 PostgreSQL 存储）
 * - 元数据：kh_document
 * - 正文：kh_document_content（1:1，document_id 主键）
 *
 * 🟡 与参考项目的分叉：参考项目用 PG + Mongo 双库（正文在 Mongo），
 * 本项目于 2026-09-20 切换为单 PostgreSQL——Mongo 侧原始规划的
 * chunks / chat_histories 已分别落在 ES / 未启动，只剩正文一个集合，
 * 为它维护一整套独立数据库得不偿失。
 * 直接受益：create 从「先写 Mongo 拿 _id → 写 PG → 失败补偿删 Mongo」
 * 简化为单库事务，双写补偿逻辑整体删除。
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    /** Postgres 实体管理器 */
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly fileParserService: FileParserService,
    private readonly rustfs: RustfsService,
    private readonly ragOrchestrator: RagOrchestrator,
    /** 文档级全文搜索索引（ES kh_document）；与 RAG 的 kh_chunk 互补 */
    private readonly searchIndexService: SearchIndexService,
    /** KG 建图队列生产者；KG 单块抽取实测 19~57s，必须异步投递 */
    private readonly kgBuildPublisher: KgBuildPublisher,
  ) {}

  /**
   * 创建文档
   * 流程：生成雪花 ID → 单事务内写 kh_document + kh_document_content
   *
   * 双库时代这里是「先写 Mongo 拿 _id → 写 PG → 失败补偿删 Mongo」；
   * 切单 PostgreSQL 后两表同库同事务，要么全成要么全无，补偿逻辑整体删除。
   *
   * @param fileInfo 内部参数：上传链路传入的源文件元数据（在线创建时缺省）
   */
  async create(dto: CreateDocumentDto, fileInfo?: DocumentFileInfo) {
    const id = nextSnowflakeId();
    const wordCount = this.countWords(dto.content);
    const status = dto.status ?? DocumentStatus.Draft;
    // 未传 summary 时，从正文截取预览作为 contentSummary
    const contentSummary = dto.summary ?? this.buildContentSummary(dto.content);

    const saved = await this.em.transaction(async (tx) => {
      const doc = tx.create(DocumentEntity, {
        id,
        title: dto.title,
        summary: dto.summary,
        categoryId: dto.categoryId,
        teamId: dto.teamId,
        authorId: dto.authorId,
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
        createBy: dto.createBy,
        updateBy: dto.createBy,
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
   * - 首次变为「已发布」时写入 publishTime
   */
  async update(id: string, dto: UpdateDocumentDto) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    // —— 正文变更 ——
    if (dto.content !== undefined) {
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

    // 状态从非发布 → 发布时，记录发布时间
    if (dto.status !== undefined) {
      if (
        dto.status === DocumentStatus.Published &&
        doc.status !== DocumentStatus.Published
      ) {
        doc.publishTime = new Date();
      }
      doc.status = dto.status;
    }

    const saved = await this.em.save(doc);

    // 本次已带新正文则直接返回；否则再查一次内容表
    if (dto.content !== undefined) {
      return { ...saved, content: dto.content };
    }

    return { ...saved, content: await this.loadContent(id) };
  }

  /**
   * 发布文档：置为已发布 → 建两条索引
   *   1. RAG：分块 → 嵌入 → 写 ES `kh_chunk`（需要 ES + Embedding Key）
   *   2. Search：整篇快照 → 写 ES `kh_document`（只需要 ES）
   *
   * 阶段一为**同步执行**：索引失败直接上抛，客户端可重试（管线幂等：先删旧块再覆盖写）。
   *
   * 降级：ES 不可用或未配置 Embedding Key 时，仍完成发布但 `indexed=false`，
   * 不让基础设施故障阻断发布动作。两条链路可用性**分开判定**——
   * 没配 Embedding Key 时文档搜索仍可用，只有语义检索降级。
   *
   * 🟢 对齐参考项目 knowledge-hub-backend：仅「草稿 / 已发布」允许发布，
   * 已归档（Archived）文档不允许重新发布 —— 归档是明确的终态，
   * 若放开会导致已下线文档被重新向量化并回到检索结果里。
   * （本条此前遗漏，已对照 v3 补齐。）
   */
  async publish(id: string) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    if (
      doc.status !== DocumentStatus.Draft &&
      doc.status !== DocumentStatus.Published
    ) {
      throw new BadRequestException('当前文档状态不允许发布');
    }

    if (doc.status !== DocumentStatus.Published) {
      doc.status = DocumentStatus.Published;
      if (!doc.publishTime) doc.publishTime = new Date();
      await this.em.save(doc);
    }

    const content = await this.loadContent(id);
    const pipelineDoc = this.toPipelineDocument(doc, content);

    // RAG 与 Search 的可用性**分开判定**：
    // RAG 需要 ES + Embedding Key；Search 只需要 ES。
    // 没配 Key 时文档搜索仍应可用，不能一刀切把整条索引链路判死。
    let chunks = 0;
    let indexed = false;
    if (this.ragOrchestrator.isAvailable()) {
      const result = await this.ragOrchestrator.indexDocument(pipelineDoc);
      chunks = result.chunks;
      indexed = true;
    } else {
      this.logger.warn(
        `RAG 索引链路不可用，已发布但未建向量索引：documentId=${id}（检查 ELASTICSEARCH_ENABLED / EMBEDDING_API_KEY）`,
      );
    }

    const searchIndexed = await this.indexForSearch(pipelineDoc);

    // KG 建图走异步队列：单块 LLM 抽取实测 19~57s（见 kg/extraction-e2e.spec.ts），
    // 同步会撞网关超时。队列不可用只降级，不阻断发布。
    const kgTaskId = await this.safeEnqueueKgBuild(id);

    return {
      id,
      status: doc.status,
      publishTime: doc.publishTime,
      indexed,
      chunks,
      searchIndexed,
      kgQueued: kgTaskId != null,
    };
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
   * 供重建队列的 Worker 使用。参考项目把这段放在 `PipelineOrchestrator` 内部
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

    // 清理 ES 向量块：跨系统无事务，失败只记日志，不阻断删除（检索侧另有兜底过滤）
    let vectorsCleaned = false;
    try {
      await this.ragOrchestrator.deleteDocument(id);
      vectorsCleaned = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `删除文档后清理 ES 向量块失败（检索侧会兜底过滤）：documentId=${id}, ${message}`,
      );
    }

    // 清理文档级搜索索引：与向量块无关，独立 try，避免一侧失败连累另一侧
    let searchCleaned = false;
    try {
      await this.searchIndexService.deleteDocument(id);
      searchCleaned = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `删除文档后清理文档搜索索引失败（检索侧会兜底过滤）：documentId=${id}, ${message}`,
      );
    }

    // KG 图谱清理走异步队列（幂等：文档不存在等价于空操作）
    let kgDeleteQueued = false;
    if (this.kgBuildPublisher.isAvailable()) {
      try {
        kgDeleteQueued =
          (await this.kgBuildPublisher.enqueueDeleteByDocIds([id])) != null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `删除文档后 KG 清理任务入队失败：documentId=${id}, ${message}`,
        );
      }
    }

    return { id, deleted: true, vectorsCleaned, searchCleaned, kgDeleteQueued };
  }

  /** 上传并解析文件 → 创建草稿文档 */
  async uploadAndCreateDocument(
    file: Express.Multer.File,
    meta: UploadParseDto = {},
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
    if (this.rustfs.isEnabled()) {
      try {
        uploadResult = await this.rustfs.uploadBytes(file.buffer, {
          fileName: originalFilename,
          contentType: file.mimetype || 'application/octet-stream',
          prefix: 'documents',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`原文件上传 RustFS 失败：${message}`);
        throw new BadRequestException(`原文件上传失败: ${message}`);
      }
    } else {
      this.logger.warn('RustFS 未启用，跳过原文件上传');
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
