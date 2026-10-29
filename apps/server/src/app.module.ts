import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DocumentModule } from './document/document.module.js';
import { TeamModule } from './team/team.module.js';

import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { StorageModule } from './storage/storage.module.js';
import { RagModule } from './rag/rag.module.js';
import { MqModule } from './mq/mq.module.js';
import { KgModule } from './kg/kg.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AiModule } from './ai/ai.module.js';
import { HealthModule } from './health/health.module.js';
import { buildTypeOrmOptions } from './database/typeorm.options.js';
import { IndexMaintenanceModule } from './indexing/index-maintenance.module.js';
import { NotificationModule } from './notification/notification.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 单 PostgreSQL 存储（2026-09-20 起）：正文并入 kh_document_content，
    // MongoDB/Mongoose 已整体移除。连接参数与迁移 CLI 共用 typeorm.options.ts。
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildTypeOrmOptions(config),
    }),
    DocumentModule,
    StorageModule,
    RagModule,
    // 阶段二：BullMQ 异步重建队列（publish 仍同步，队列只服务批量重建）
    MqModule,
    // feat-v5：KG 知识图谱（抽取 + Neo4j 建图 + BullMQ kg.graph 队列）
    KgModule,
    // feat-v7：用户鉴权（JWT 双令牌 + 全局守卫）
    AuthModule,
    // feat-v9：RBAC 权限体系（权限树 + 三层 Guard）与独立团队组织架构模块
    TeamModule,
    // feat-v11：AI 对话（RAG 检索精排 → LLM 生成 → [n] 引用溯源）
    AiModule,
    // 索引失败 outbox 重试与 ES/KG 可见性巡检
    IndexMaintenanceModule,
    // 存活 / 就绪探针（真实探测 PG、Redis、ES、Neo4j）
    HealthModule,
    // feat-v21：站内通知（互动通知 + 管理员广播）
    NotificationModule,
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
