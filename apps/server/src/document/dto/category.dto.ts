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
import { PartialType } from '@nestjs/mapped-types';

/** 新建分类 */
export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  /** 父分类 ID，不传或 '0' 表示根分类 */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/** 更新分类（字段均可选） */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
