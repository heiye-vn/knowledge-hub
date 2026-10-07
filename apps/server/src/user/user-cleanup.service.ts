import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserService, DEFAULT_INACTIVE_TTL_DAYS } from './user.service.js';

/**
 * 未激活账号过期清理（TODO §8.4）
 *
 * 触发方式采用「启动时惰性执行」而非独立定时任务：本项目目前没有
 * @nestjs/schedule，清理是一次性的低频 SQL，进程重启时顺手做一次即可覆盖
 * （配合 `POST /users/purge-inactive` 的管理员手动入口兜底）。
 *
 * 开关：`PURGE_INACTIVE_ON_BOOT`（默认 true，`false` 关闭）
 * 天数：`INACTIVE_ACCOUNT_TTL_DAYS`（默认 7 天）
 *
 * 只软删，不物理删除——用户名 / 邮箱的部分唯一索引（`WHERE deleted=false`）
 * 会自动释放被占位的标识，且保留痕迹便于追溯滥用。
 */
@Injectable()
export class UserCleanupService implements OnModuleInit {
  private readonly logger = new Logger(UserCleanupService.name);

  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('PURGE_INACTIVE_ON_BOOT', 'true') !== 'true') {
      return;
    }

    const raw = Number(
      this.config.get<string>(
        'INACTIVE_ACCOUNT_TTL_DAYS',
        String(DEFAULT_INACTIVE_TTL_DAYS),
      ),
    );
    const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INACTIVE_TTL_DAYS;

    try {
      const { purged, cutoff } = await this.userService.purgeInactiveAccounts(days);
      if (purged > 0) {
        this.logger.log(
          `启动清理未激活账号：${purged} 个（创建早于 ${cutoff.toISOString()}）`,
        );
      }
    } catch (error) {
      // 清理失败不应阻断启动：这是治理动作，不是启动前置条件
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`未激活账号清理失败（已跳过）：${message}`);
    }
  }
}
