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
import { PermissionService } from './permission.service.js';
import {
  CreatePermissionDto,
  QueryPermissionDto,
  UpdatePermissionDto,
} from './dto/permission.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * 权限管理接口。
 *
 * 【分叉】不标 @Roles(ADMIN)，仅用 @RequirePermission 权限码控制——
 * 权限码要真正生效，就不能再用角色做前置拦截（否则 RolesGuard 先 403，
 * 「给非管理员直接授权 system:permission」的路径永远走不到）。
 * 管理员由 PermissionsGuard 的 ADMIN 短路保证访问，无需显式绑定权限。
 *
 * 【易错】路由顺序：具名路由（tree/page/list）必须声明在 :id 之前。
 */
@Controller('permissions')
@RequirePermission('system:permission')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  @Get('list')
  listAll() {
    return this.permissionService.listAll();
  }

  @Get('tree')
  tree() {
    return this.permissionService.getTree();
  }

  @Get('page')
  page(@Query() query: QueryPermissionDto) {
    return this.permissionService.page(query);
  }

  @Get(':id/children')
  async children(@Param('id') id: string) {
    await this.permissionService.getById(id);
    return this.permissionService.getChildren(id);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.permissionService.getById(id);
  }

  @Post()
  @RequirePermission('system:permission:create')
  create(@Body() dto: CreatePermissionDto) {
    return this.permissionService.create(dto);
  }

  @Put(':id')
  @RequirePermission('system:permission:edit')
  update(@Param('id') id: string, @Body() dto: UpdatePermissionDto) {
    return this.permissionService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('system:permission:delete')
  async delete(@Param('id') id: string) {
    await this.permissionService.delete(id);
    return { message: '删除成功' };
  }
}
