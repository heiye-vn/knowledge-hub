import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { RoleCode } from '../common/constants/roles.js';
import { BroadcastNotificationDto, QueryNotificationsDto } from './notification.dto.js';
import { NotificationService } from './notification.service.js';

/**
 * 站内通知。
 *
 * 个人通知接口登录即可访问（读写都限定在当前用户自己的记录）；
 * 广播仅管理员可用，沿用角色语义，不叠加权限码。
 */
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: QueryNotificationsDto) {
    return this.notifications.list(
      user.userId,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.userId);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.userId);
  }

  @Post('broadcast')
  @Roles(RoleCode.ADMIN)
  broadcast(@Body() dto: BroadcastNotificationDto, @CurrentUser() user: AuthUser) {
    return this.notifications.broadcast(dto, {
      userId: user.userId,
      name: user.realName || user.username,
    });
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(user.userId, id);
  }
}
