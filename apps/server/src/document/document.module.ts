import { Module } from '@nestjs/common';
import { DocumentService } from './document.service.js';
import { DocumentController } from './document.controller.js';

@Module({
  controllers: [DocumentController],
  providers: [DocumentService],
})
export class DocumentModule {}
