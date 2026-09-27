import { Controller, Get, Param } from '@nestjs/common';
import { TaskStatusService } from './task-status.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 队列任务状态查询接口
 *
 * 🔵 **相对基线实现的新增**：BullMQ 有 jobId 但没有查询入口时，
 * 建图 / 批量重建跑到哪一步只能看日志（异步链路不可观测）。
 * 本接口与触发入口（`POST /kg/build`、`POST /rag/reindex`）配对使用：
 * 触发返回 taskId → 用 taskId 轮询本接口直到 completed / failed。
 *
 * 权限：两个触发入口均为 ADMIN，状态查询保持一致。
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
