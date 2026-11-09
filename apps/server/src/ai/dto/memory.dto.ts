import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { MemoryLayer } from '../chat-long-memory.service.js';

/**
 * 长期记忆列表（GET /ai/memory）
 *
 * layer=user 查跨会话画像；layer=session 必须带 sessionId，
 * 否则缺少 run_id 过滤条件，无法定位会话层（服务端返回空页而非全量）。
 */
export class QueryMemoryDto {
  @IsOptional()
  @IsIn(['user', 'session'])
  layer?: MemoryLayer = 'user';

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
