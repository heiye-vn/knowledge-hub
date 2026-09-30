import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { RoleService } from './role.service.js';
import { PermissionService } from './permission.service.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { AssignPermissionIdsDto } from './dto/permission.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * 角色管理接口。
 *
 * 【分叉】不标 @Roles(ADMIN)，仅用 system:role 权限码——
 * 让「给角色授 system:role 权限后由其成员管理角色」成为可行路径；
 * 管理员由 PermissionsGuard 短路保证访问。
 *
 * 【易错】路由顺序：:id/permissions 必须声明在 :id 之前。
 */
@Controller('roles')
@RequirePermission('system:role')
export class RoleController {
  constructor(
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
  ) {}

  @Get('list')
  listRoles() {
    return this.roleService.listAll();
  }

  /** 角色已绑定的权限 ID 列表 */
  @Get(':id/permissions')
  async getRolePermissions(@Param('id') id: string) {
    const permissionIds =
      await this.permissionService.getRolePermissionIds(id);
    return { roleId: id, permissionIds };
  }

  /** 整体替换角色的权限绑定（传空数组即清空） */
  @Put(':id/permissions')
  async assignRolePermissions(
    @Param('id') id: string,
    @Body() dto: AssignPermissionIdsDto,
  ) {
    const permissionIds = await this.permissionService.assignRolePermissions(
      id,
      dto,
    );
    return { roleId: id, permissionIds };
  }

  @Get(':id')
  getRole(@Param('id') id: string) {
    return this.roleService.getById(id);
  }

  @Post()
  createRole(@Body() dto: CreateRoleDto) {
    return this.roleService.create(dto);
  }

  @Put(':id')
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.update(id, dto);
  }

  @Delete(':id')
  async deleteRole(@Param('id') id: string) {
    await this.roleService.delete(id);
    return { message: '删除成功' };
  }
}
