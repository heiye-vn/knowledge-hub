import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto.js';

/** 更新文档（字段均可选） */
// 字段全量转可选（Partial Update）
export class UpdateDocumentDto extends PartialType(
  //  OmitType:剔除只读审计字段
  OmitType(CreateDocumentDto, ['createBy'] as const),
) {
  /** 更新人 ID */
  @IsOptional()
  @IsString()
  updateBy?: string;
}
