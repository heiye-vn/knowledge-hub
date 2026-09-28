import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service.js';
import { RoleService } from './role.service.js';
import { UserController } from './user.controller.js';
import { RoleController } from './role.controller.js';
import { UserEntity } from './entities/user.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { DocumentEntity } from '../document/entities/document.entity.js';

/**
 * 用户模块：三表仓储 + 用户/角色服务 + 管理接口。
 * /users/me、/users/me/stats、/users/password/change 登录即可，
 * 其余用户管理接口与整个 /roles 仅 ROLE_ADMIN 可访问（controller 上标注）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      RoleEntity,
      UserRoleEntity,
      DocumentEntity,
    ]),
  ],
  controllers: [UserController, RoleController],
  providers: [UserService, RoleService],
  exports: [UserService, RoleService],
})
export class UserModule {}
