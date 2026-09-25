import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Put,
  Delete,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { DocumentService } from './document.service.js';
import { DocumentReviewService } from './document-review.service.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';
import { QueryDocumentDto } from './dto/query-document.dto.js';
import { UploadParseDto } from './dto/upload-parse.dto.js';
import {
  QueryReviewTasksDto,
  ReviewDecisionDto,
} from './dto/review.dto.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * 文档接口
 *
 * 鉴权约定：全接口需登录（全局 JwtAuthGuard）；写操作的操作人字段
 * （authorId / createBy / updateBy / 审核人）一律从登录态取，
 * DTO 里的同名字段仅作显式覆盖（兼容脚本调用）；审核工作台需
 * ROLE_REVIEWER 或 ROLE_ADMIN。
 */
@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly reviewService: DocumentReviewService,
  ) {}

  /** 创建文档 */
  @Post()
  create(@Body() dto: CreateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.create(dto, undefined, user);
  }

  /** 上传文件并解析为 Markdown，创建草稿（form-data 字段名: file） */
  @Post('upload/parse')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadAndParse(
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadParseDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) {
      throw new BadRequestException('请上传文件（form-data 字段名: file）');
    }
    return this.documentService.uploadAndCreateDocument(file, meta, user);
  }

  // -------------------------------------------------------------------------
  // 审核工作台
  // ⚠️ 必须注册在 @Get(':id') 之前，否则会被 :id 路由吃掉（Nest 按声明顺序匹配）
  // -------------------------------------------------------------------------

  /** 审核任务列表（默认待办；status=pending|approved|rejected） */
  @Get('reviews/tasks')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  listReviewTasks(@Query() query: QueryReviewTasksDto) {
    return this.reviewService.listTasks(query);
  }

  /** 待审核数量（工作台角标） */
  @Get('reviews/tasks/pending-count')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  pendingReviewCount() {
    return this.reviewService.getPendingCount();
  }

  /** 审核通过：文档转已发布并建三条索引（审核人取自登录态） */
  @Post('reviews/tasks/:taskId/approve')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  approveReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentService.approveReview(taskId, dto, {
      reviewerId: user.userId,
      reviewerName: user.realName ?? user.username,
    });
  }

  /** 审核驳回：文档回草稿，作者改稿后可再次提交（reviewComment 必填） */
  @Post('reviews/tasks/:taskId/reject')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  rejectReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentService.rejectReview(taskId, dto, {
      reviewerId: user.userId,
      reviewerName: user.realName ?? user.username,
    });
  }

  /** 分页查询文档列表（仅元数据） */
  @Get()
  findAll(@Query() query: QueryDocumentDto) {
    return this.documentService.findAll(query);
  }

  /** 查询文档详情（含正文） */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.documentService.findOne(id);
  }

  /** 更新文档（待审核中不可改正文/标题；不允许改状态，状态走专用接口） */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentService.update(id, dto, user);
  }

  /**
   * 发布文档并触发索引（分块 → 嵌入 → 写入 ES kh_chunk）
   *
   * DOCUMENT_REQUIRE_APPROVAL=true（默认）时本接口等价「提交审核」：
   * 文档转为待审核（3）且不建索引，需由审核员 approve 后才进索引。
   * 设为 false 时免审直发，立即建三条索引。
   *
   * 注意：仅本接口会触发索引；直接 PATCH status 会被拒绝（不允许改状态）。
   * 管线幂等，重复发布会先清旧块再覆盖写。
   */
  @Put(':id/publish')
  publish(@Param('id') id: string) {
    return this.documentService.publish(id);
  }

  /** 提交审核：草稿 / 已发布 → 待审核（原为已发布会先清索引） */
  @Post(':id/reviews/submit')
  submitReview(@Param('id') id: string) {
    return this.documentService.submitForReview(id);
  }

  /** 当前待审任务（无则 null） */
  @Get(':id/reviews/current')
  getCurrentReview(@Param('id') id: string) {
    return this.reviewService.getCurrentReview(id);
  }

  /** 该文档全部审核记录（含已通过 / 已驳回），按提交时间倒序 */
  @Get(':id/reviews/history')
  getReviewHistory(@Param('id') id: string) {
    return this.reviewService.getReviewHistory(id);
  }

  /** 归档：已发布 → 已归档（终态），清索引但保留正文 */
  @Put(':id/archive')
  archive(@Param('id') id: string) {
    return this.documentService.archive(id);
  }

  /** 下架编辑：已发布 → 草稿，清索引后可改内容再重新发布 / 提审 */
  @Put(':id/save-draft')
  saveAsDraft(@Param('id') id: string) {
    return this.documentService.saveAsDraft(id);
  }

  /** 软删除文档（已发布的同时清索引，其余状态本就不在索引里） */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.documentService.remove(id);
  }
}
