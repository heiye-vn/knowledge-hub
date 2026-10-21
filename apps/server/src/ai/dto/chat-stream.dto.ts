import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  SEARCH_MODES,
  type SearchMode,
} from '../../rag/types/rag.types.js';

/**
 * 流式对话请求体（useChat 发送的 UI Message 数组）。
 *
 * messages 为 UIMessage 结构（role + parts[]），服务端只取最后一条
 * user 消息的文本作为本轮问题。id / trigger / messageId 是 SDK 自动
 * 附加的字段，必须 @Allow 放行——全局 ValidationPipe 开了
 * forbidNonWhitelisted，不放行会直接 400。
 */
export class ChatStreamDto {
  @IsArray()
  messages: Array<{
    role?: string;
    parts?: Array<{ type?: string; text?: string }>;
  }>;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number;

  /** 检索模式；默认 hybrid */
  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode?: SearchMode;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @Allow()
  trigger?: unknown;

  @IsOptional()
  @Allow()
  messageId?: unknown;
}
