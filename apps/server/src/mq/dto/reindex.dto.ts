import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * 触发 RAG 重建索引的入参
 *
 * `documentIds` 省略表示「重建全部已发布文档」——这是换 embedding 模型后的典型用法
 * （不同模型向量空间不兼容，必须全量重索引）。
 */
export class ReindexDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  documentIds?: string[];
}
