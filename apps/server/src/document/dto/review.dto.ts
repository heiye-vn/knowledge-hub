import { IsOptional, IsString } from 'class-validator';
import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 审核任务列表查询（审核员工作台）
 * status 省略时按 pending 处理 —— 工作台默认只看待办
 */
export class QueryReviewTasksDto {
  /** 筛选：pending 待办 | approved 已通过 | rejected 已驳回 */
  @IsOptional()
  @IsString()
  status?: 'pending' | 'approved' | 'rejected';

  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** 每页条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/**
 * 审核通过 / 驳回请求体
 *
 * 🟡 reviewerId / reviewerName 暂时由调用方传入：项目尚未接入鉴权（auth 属后续迭代），
 * 服务层无从得知操作人。接入登录后应改为从登录态取值，本 DTO 对应字段随之废弃。
 */
export class ReviewDecisionDto {
  /** 审核意见（驳回时必填） */
  @IsOptional()
  @IsString()
  reviewComment?: string;

  /** 审核人 ID */
  @IsOptional()
  @IsString()
  reviewerId?: string;

  /** 审核人姓名 */
  @IsOptional()
  @IsString()
  reviewerName?: string;
}
