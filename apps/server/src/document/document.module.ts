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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    // 发布时触发 RAG 管线（分块 → 嵌入 → ES）
    RagModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService, FileParserService],
  exports: [DocumentService, FileParserService],
})
export class DocumentModule {}
