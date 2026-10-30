import { Controller, Get, Param } from '@nestjs/common';
import { TaskStatusService } from './task-status.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 队列任务状态查询接口
 *
 * 与触发入口（`POST /kg/build`、`POST /rag/reindex`）配对使用：
 * 触发返回 taskId → 用 taskId 查询状态（waiting / active / completed / failed）。
 * 权限：统一收敛在 ADMIN。
 */
@Controller('tasks')
export class TaskStatusController {
  constructor(private readonly taskStatusService: TaskStatusService) {}

  /**
   * 按 taskId 查询任务状态（`kg.graph` / `rag.reindex` 两个队列通用）。
   * taskId 即入队响应里返回的 UUID（BullMQ jobId）。
   */
  @Get(':taskId')
  @Roles(RoleCode.ADMIN)
  async status(@Param('taskId') taskId: string) {
    return this.taskStatusService.getTaskStatus(taskId);
  }
}
