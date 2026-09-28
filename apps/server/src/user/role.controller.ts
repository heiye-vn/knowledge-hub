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
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/** 角色管理接口：整个 controller 仅 ROLE_ADMIN 可访问 */
@Controller('roles')
@Roles(RoleCode.ADMIN)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get('list')
  listRoles() {
    return this.roleService.listAll();
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
