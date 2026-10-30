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
import { TeamService } from './team.service.js';
import {
  CreateTeamDto,
  QueryTeamDto,
  TeamMembersDto,
  UpdateTeamDto,
} from './dto/team.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * 团队管理接口。
 *
 * 【权限设计防坑】切勿在控制器类上标 @Roles(ADMIN) 又给 tree 标 @Public：
 * @Public 跳过 JWT 之后 request.user 为空，若类级别存在角色声明，
 * RolesGuard 取到类级角色仍会进行比对，导致公开接口实际返回 403。
 * 正确做法：tree 只标 @Public、类级别不标任何角色声明，确保公开语义真实生效；
 * 管理类接口细粒度挂载 system:team 权限码。
 *
 * 【易错】路由顺序：具名路由（tree/page/mine）必须声明在 :id 之前。
 */
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  /** 团队树（公开：登录前筛选下拉等场景） */
  @Public()
  @Get('tree')
  tree() {
    return this.teamService.getTree();
  }

  @Get('page')
  @RequirePermission('system:team')
  page(@Query() query: QueryTeamDto) {
    return this.teamService.page(query);
  }

  /** 当前用户所在团队（含担任负责人的），登录即可访问 */
  @Get('mine')
  listMine(@CurrentUser() user: AuthUser) {
    return this.teamService.listMine(user.userId);
  }


  @Get(':id')
  @RequirePermission('system:team')
  getDetail(@Param('id') id: string) {
    return this.teamService.getDetail(id);
  }

  @Post()
  @RequirePermission('system:team')
  create(@Body() dto: CreateTeamDto) {
    return this.teamService.create(dto);
  }

  @Put(':id')
  @RequirePermission('system:team')
  update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.teamService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('system:team')
  async delete(@Param('id') id: string) {
    await this.teamService.delete(id);
    return { message: '删除成功' };
  }

  @Get(':id/members')
  @RequirePermission('system:team')
  listMembers(@Param('id') id: string) {
    return this.teamService.listMembers(id);
  }

  @Post(':id/members')
  @RequirePermission('system:team')
  addMembers(@Param('id') id: string, @Body() dto: TeamMembersDto) {
    return this.teamService.addMembers(id, dto.userIds);
  }

  @Delete(':id/members')
  @RequirePermission('system:team')
  removeMembers(@Param('id') id: string, @Body() dto: TeamMembersDto) {
    return this.teamService.removeMembers(id, dto.userIds);
  }
}
