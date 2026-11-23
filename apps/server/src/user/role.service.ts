import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleCode } from '../common/constants/roles.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';

const BUILTIN_ROLE_CODES = new Set<string>(Object.values(RoleCode));

/**
 * 角色服务：kh_role 的读写。
 * 预置角色（ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER）受保护，禁止禁用或删除；
 * 自定义角色支持增删改，删除前校验是否仍被用户绑定并级联清理角色权限关联。
 */
@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoleRepo: Repository<UserRoleEntity>,
    private readonly em: EntityManager,
  ) {}

  async listAll(): Promise<RoleEntity[]> {
    return this.roleRepo.find({ order: { id: 'ASC' } });
  }

  async getById(id: string): Promise<RoleEntity> {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) {
      throw new NotFoundException('角色不存在');
    }
    return role;
  }

  async create(dto: CreateRoleDto): Promise<RoleEntity> {
    const exists = await this.roleRepo.findOne({
      where: { roleCode: dto.roleCode },
    });
    if (exists) {
      throw new ConflictException(`角色编码 ${dto.roleCode} 已存在`);
    }
    return this.roleRepo.save(
      this.roleRepo.create({
        id: nextSnowflakeId(),
        roleName: dto.roleName,
        roleCode: dto.roleCode,
        description: dto.description ?? null,
        status: 1,
      }),
    );
  }

  async update(id: string, dto: UpdateRoleDto): Promise<RoleEntity> {
    const role = await this.getById(id);
    if (BUILTIN_ROLE_CODES.has(role.roleCode) && dto.status === 0) {
      throw new BadRequestException('系统预置角色不允许禁用');
    }
    await this.roleRepo.update(id, {
      roleName: dto.roleName ?? role.roleName,
      description: dto.description ?? role.description,
      status: dto.status ?? role.status,
    });
    return this.getById(id);
  }

  /**
   * 删除自定义角色：
   * - 预置角色（ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER）禁止删除；
   * - 仍被用户绑定时给出明确中文提示（而非裸抛数据库外键错误）；
   * - 事务清理 kh_role_permission 关联后删除 kh_role。
   */
  async delete(id: string): Promise<void> {
    const role = await this.getById(id);
    if (BUILTIN_ROLE_CODES.has(role.roleCode)) {
      throw new BadRequestException('系统预置角色不允许删除');
    }
    const boundUsers = await this.userRoleRepo.count({ where: { roleId: id } });
    if (boundUsers > 0) {
      throw new ConflictException(
        `该角色仍绑定了 ${boundUsers} 名用户，请先解除用户角色绑定后再删除`,
      );
    }
    await this.em.transaction(async (tx) => {
      await tx.delete(RolePermissionEntity, { roleId: id });
      await tx.delete(RoleEntity, { id });
    });
  }
}
