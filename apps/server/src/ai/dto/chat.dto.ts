import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SEARCH_MODES,
  type SearchMode,
} from '../../rag/types/rag.types.js';

/** RAG 对话请求（POST /ai/chat） */
export class ChatDto {
  /** 已有会话 ID；不传则自动新建会话 */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** 用户问题 */
  @IsString()
  @IsNotEmpty()
  content!: string;

  /** 召回块数，默认 5 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number = 5;

  /** 检索模式；默认 hybrid */
  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode?: SearchMode;
}
