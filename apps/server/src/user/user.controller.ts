import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { UserService } from './user.service.js';
import { PermissionService } from './permission.service.js';
import { QueryUserDto } from './dto/query-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { AssignRolesDto } from './dto/assign-roles.dto.js';
import { AssignPermissionIdsDto } from './dto/permission.dto.js';
import { UpdateProfileDto } from './dto/profile.dto.js';
import { ChangePasswordDto, ResetPasswordDto } from './dto/password.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * 用户管理接口。
 *
 * 权限分级：
 * - /users/me、/users/me/stats、/users/password/change：登录即可；
 * - 其余：需 system:user 权限码。
 *
 * 【分叉】参考项目在权限码之外还叠了 @Roles(ADMIN)，导致 RolesGuard 先拦掉
 * 非管理员、权限码比对永远走不到；这里只保留权限码，
 * 使「给某人直接授 system:user」的临时授权路径真正可用。
 *
 * 【易错】路由声明顺序：具名路由（page、:id/permissions）必须放在 :id 之前，
 * 否则会被 :id 吞掉。
 */
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly permissionService: PermissionService,
  ) {}

  @Put('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.userService.updateProfile(user.userId, dto);
  }

  @Get('me/stats')
  getMyStats(@CurrentUser() user: AuthUser) {
    return this.userService.getUserStatistics(user.userId);
  }

  @Put('password/change')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.userService.changePassword(
      user.userId,
      dto.oldPassword,
      dto.newPassword,
    );
    return { message: '密码修改成功' };
  }

  @Get('page')
  @RequirePermission('system:user')
  pageUsers(@Query() query: QueryUserDto) {
    return this.userService.pageUsers(query);
  }

  /** 用户的最终权限码 + 直接赋权的权限 ID（角色间接权限不含在内） */
  @Get(':id/permissions')
  @RequirePermission('system:user')
  async getUserPermissions(@Param('id') id: string) {
    await this.userService.findByIdOrThrow(id);
    const permissionCodes =
      await this.permissionService.getUserPermissionCodes(id);
    const directPermissionIds =
      await this.permissionService.getUserDirectPermissionIds(id);
    return { userId: id, permissionCodes, directPermissionIds };
  }

  /** 整体替换用户的直接权限（传空数组即清空） */
  @Put(':id/permissions')
  @RequirePermission('system:user')
  async assignUserPermissions(
    @Param('id') id: string,
    @Body() dto: AssignPermissionIdsDto,
  ) {
    await this.userService.findByIdOrThrow(id);
    const permissionIds = await this.permissionService.assignUserPermissions(
      id,
      dto,
    );
    return { userId: id, permissionIds };
  }

  @Get(':id')
  @RequirePermission('system:user')
  getUser(@Param('id') id: string) {
    return this.userService.toUserVOById(id);
  }

  /**
   * 手动清理过期未激活账号（TODO §8.4）
   * 软删 `email_verified=0` 且创建超过 days 天（默认 7）的账号，释放被占位的邮箱/用户名。
   */
  @Post('purge-inactive')
  @RequirePermission('system:user')
  purgeInactive(@Query('days') days?: string) {
    const parsed = days ? Number(days) : undefined;
    return this.userService.purgeInactiveAccounts(
      parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    );
  }

  @Post()
  @RequirePermission('system:user')
  async createUser(@Body() dto: CreateUserDto) {
    const userId = await this.userService.createUser(dto);
    return this.userService.toUserVOById(userId);
  }

  @Put(':id')
  @RequirePermission('system:user')
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.userService.updateUser(id, dto);
  }

  @Delete(':id')
  @RequirePermission('system:user')
  async deleteUser(@Param('id') id: string) {
    await this.userService.deleteUser(id);
    return { message: '删除成功' };
  }

  @Put(':id/password/reset')
  @RequirePermission('system:user')
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    await this.userService.resetPassword(id, dto.newPassword);
    return { message: '密码重置成功' };
  }

  @Get(':id/roles')
  @RequirePermission('system:user')
  async getUserRoles(@Param('id') id: string) {
    await this.userService.findByIdOrThrow(id);
    const roleCodes = await this.userService.getRoleCodes(id);
    return { userId: id, roleCodes };
  }

  @Put(':id/roles')
  @RequirePermission('system:user')
  async assignRoles(@Param('id') id: string, @Body() dto: AssignRolesDto) {
    const roleCodes = await this.userService.replaceRoles(id, dto.roleCodes);
    return { userId: id, roleCodes };
  }
}
