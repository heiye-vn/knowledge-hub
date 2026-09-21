import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentService } from './document.service.js';
import { DocumentController } from './document.controller.js';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema.js';
import { FileParserService } from './parser/file-parser.service.js';
import { RagModule } from '../rag/rag.module.js';
import { SearchModule } from '../search/search.module.js';
import { KgModule } from '../kg/kg.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    // 发布时触发 RAG 管线（分块 → 嵌入 → ES kh_chunk）
    RagModule,
    // 发布 / 删除时同步维护文档级搜索索引（ES kh_document）
    SearchModule,
    // 发布 / 删除时投递 KG 建图 / 清理任务（BullMQ kg.graph 队列）
    KgModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService, FileParserService],
  exports: [DocumentService, FileParserService],
})
export class DocumentModule {}
