import { Controller, Get, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import { IndexOutboxService } from './index-outbox.service.js';
import { VisibilityPatrolService } from './visibility-patrol.service.js';

/**
 * 索引运维入口（管理员）：
 * - outbox 统计：看补偿积压与 dead 任务
 * - 手动巡检：定时任务关闭（VISIBILITY_PATROL_ENABLED=false）时的兜底
 */
@Controller('indexing')
export class IndexMaintenanceController {
  constructor(
    private readonly outbox: IndexOutboxService,
    private readonly patrol: VisibilityPatrolService,
  ) {}

  /** 索引补偿任务统计（按状态分组：pending / retry / succeeded / dead） */
  @Get('outbox/stats')
  @Roles(RoleCode.ADMIN)
  stats() {
    return this.outbox.stats();
  }

  /** 手动触发一轮可见性巡检（幂等，以写代检） */
  @Post('patrol/run')
  @Roles(RoleCode.ADMIN)
  runPatrol() {
    return this.patrol.run();
  }
}
