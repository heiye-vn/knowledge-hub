import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamEntity } from './entities/team.entity.js';
import { TeamMemberEntity } from './entities/team-member.entity.js';
import { UserEntity } from '../user/entities/user.entity.js';
import { TeamService } from './team.service.js';
import { TeamController } from './team.controller.js';

/**
 * 团队组织架构模块（与 RBAC 权限体系无关）。
 *
 * 只承载「部门 / 成员」数据，为第 64 讲文档可见性过滤
 * （kh_document.team_id）提供组织维度来源；接口本身用
 * system:team 权限码做访问控制。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TeamEntity, TeamMemberEntity, UserEntity]),
  ],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
