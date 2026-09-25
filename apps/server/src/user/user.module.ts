import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service.js';
import { UserEntity } from './entities/user.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';

/**
 * 用户模块：三表仓储 + UserService。
 * 账户管理接口（改密 / 禁用 / 角色分配后台）属后续迭代，本期只出服务层。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, RoleEntity, UserRoleEntity])],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
