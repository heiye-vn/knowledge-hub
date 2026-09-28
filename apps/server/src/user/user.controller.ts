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
import { QueryUserDto } from './dto/query-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { AssignRolesDto } from './dto/assign-roles.dto.js';
import { UpdateProfileDto } from './dto/profile.dto.js';
import { ChangePasswordDto, ResetPasswordDto } from './dto/password.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * 用户管理接口。
 *
 * 权限分级：
 * - /users/me、/users/me/stats、/users/password/change：登录即可；
 * - 其余：仅 ROLE_ADMIN。
 *
 * 【易错】路由声明顺序：@Get('page') 必须放在 @Get(':id') 之前，
 * 否则 'page' 会被 :id 吞掉。
 */
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

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
  @Roles(RoleCode.ADMIN)
  pageUsers(@Query() query: QueryUserDto) {
    return this.userService.pageUsers(query);
  }

  @Get(':id')
  @Roles(RoleCode.ADMIN)
  getUser(@Param('id') id: string) {
    return this.userService.toUserVOById(id);
  }

  @Post()
  @Roles(RoleCode.ADMIN)
  async createUser(@Body() dto: CreateUserDto) {
    const userId = await this.userService.createUser(dto);
    return this.userService.toUserVOById(userId);
  }

  @Put(':id')
  @Roles(RoleCode.ADMIN)
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.userService.updateUser(id, dto);
  }

  @Delete(':id')
  @Roles(RoleCode.ADMIN)
  async deleteUser(@Param('id') id: string) {
    await this.userService.deleteUser(id);
    return { message: '删除成功' };
  }

  @Put(':id/password/reset')
  @Roles(RoleCode.ADMIN)
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    await this.userService.resetPassword(id, dto.newPassword);
    return { message: '密码重置成功' };
  }

  @Get(':id/roles')
  @Roles(RoleCode.ADMIN)
  async getUserRoles(@Param('id') id: string) {
    await this.userService.findByIdOrThrow(id);
    const roleCodes = await this.userService.getRoleCodes(id);
    return { userId: id, roleCodes };
  }

  @Put(':id/roles')
  @Roles(RoleCode.ADMIN)
  async assignRoles(@Param('id') id: string, @Body() dto: AssignRolesDto) {
    const roleCodes = await this.userService.replaceRoles(id, dto.roleCodes);
    return { userId: id, roleCodes };
  }
}
