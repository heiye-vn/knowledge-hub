import { Controller, Get, Query } from '@nestjs/common';
import { AuditLogService } from './audit-log.service.js';
import { QueryAuditLogDto } from './dto/query-audit-log.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditLogService) {}

  /** 最近操作记录（默认 10 条；管理员看全部，普通用户只看自己的） */
  @Get('logs')
  recent(@Query() query: QueryAuditLogDto, @CurrentUser() user: AuthUser) {
    return this.audit.recent(user, query.limit ?? 10);
  }
}
