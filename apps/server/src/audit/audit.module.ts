import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * 审计日志模块
 *
 * 只提供「记录 + 最近查询」两个能力；由于 `record` 需要被文档/审核等
 * 多个模块调用，必须 exports 出去（DocumentModule 导入本模块后注入）。
 */
@Module({
  controllers: [AuditController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
