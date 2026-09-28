import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleEntity } from './entities/role.entity.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';

/**
 * 角色服务：kh_role 的读写。
 * 预置角色（ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER）初始化脚本写入，
 * 此处提供管理接口的增删改查。
 */
@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
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
    await this.roleRepo.update(id, {
      roleName: dto.roleName ?? role.roleName,
      description: dto.description ?? role.description,
      status: dto.status ?? role.status,
    });
    return this.getById(id);
  }

  /** 删除角色：已被用户引用的角色删不掉（M:N 外键约束），需先解绑 */
  async delete(id: string): Promise<void> {
    await this.getById(id);
    await this.roleRepo.delete(id);
  }
}
