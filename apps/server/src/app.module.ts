import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DocumentModule } from './document/document.module.js';
import { DocumentEntity } from './document/entities/document.entity.js';
import { DocumentContentEntity } from './document/entities/document-content.entity.js';

import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { StorageModule } from './storage/storage.module.js';
import { RagModule } from './rag/rag.module.js';
import { MqModule } from './mq/mq.module.js';
import { KgModule } from './kg/kg.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 🟡 单 PostgreSQL 存储（2026-09-20 起）：正文并入 kh_document_content，
    // MongoDB/Mongoose 已整体移除（原 Mongo 侧只剩正文一个集合，得不偿失）
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'user'),
        password: config.get<string>('POSTGRES_PASSWORD', '123456'),
        database: config.get<string>('POSTGRES_DB', 'knowledge_hub'),
        entities: [DocumentEntity, DocumentContentEntity],
        synchronize: false,
      }),
    }),
    DocumentModule,
    StorageModule,
    RagModule,
    // 阶段二：BullMQ 异步重建队列（publish 仍同步，队列只服务批量重建）
    MqModule,
    // feat-v5：KG 知识图谱（抽取 + Neo4j 建图 + BullMQ kg.graph 队列）
    KgModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
