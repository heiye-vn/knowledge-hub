import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DocumentModule } from './document/document.module.js';

@Module({
  imports: [DocumentModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
