import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 会话列表分页（GET /ai/sessions） */
export class QuerySessionDto {
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

/** 新建空会话（POST /ai/sessions） */
export class CreateSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;
}

/** 重命名会话（PATCH /ai/sessions/:id） */
export class UpdateSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;
}
