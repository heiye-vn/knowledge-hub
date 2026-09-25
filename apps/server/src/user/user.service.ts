import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { UserEntity } from './entities/user.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';

/**
 * 用户服务：账户与角色的读写。
 *
 * 职责边界：只管 kh_user / kh_role / kh_user_role 三表；
 * Token 签发与校验在 AuthService，这里不感知 JWT。
 */
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoleRepo: Repository<UserRoleEntity>,
  ) {}

  /** 按用户名查未删除用户（软删数据不算，避免注册查重误判） */
  async findByUsername(username: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: { username, deleted: false },
    });
  }

  async findByIdOrThrow(userId: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({
      where: { id: userId, deleted: false },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  /** 查用户的有效角色编码（禁用角色不参与鉴权） */
  async getRoleCodes(userId: string): Promise<string[]> {
    const rows = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .where('ur.user_id = :userId', { userId })
      .andWhere('r.status = 1')
      .select('r.role_code', 'roleCode')
      .getRawMany<{ roleCode: string }>();
    return rows.map((r) => r.roleCode);
  }

  /** Entity → 鉴权用视图对象（不含密码） */
  toAuthUser(user: UserEntity, roles: string[]): AuthUser {
    return {
      userId: user.id,
      username: user.username,
      realName: user.realName,
      email: user.email,
      avatar: user.avatar,
      roles,
    };
  }

  /** 按 ID 重建当前用户信息（禁用账户拒绝），JwtStrategy / me / refresh 共用 */
  async buildAuthUser(userId: string): Promise<AuthUser> {
    const user = await this.findByIdOrThrow(userId);
    if (user.status !== 1) {
      throw new UnauthorizedException('账户已禁用');
    }
    const roles = await this.getRoleCodes(userId);
    return this.toAuthUser(user, roles);
  }

  /**
   * 登录凭据校验。
   * 用户不存在与密码错误统一报「用户名或密码错误」——
   * 防止攻击者借差异报错枚举出真实用户名。
   */
  async validateCredentials(
    username: string,
    password: string,
  ): Promise<AuthUser> {
    const user = await this.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.status !== 1) {
      throw new UnauthorizedException('账户已禁用');
    }
    const ok = await compare(password, user.password);
    if (!ok) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const roles = await this.getRoleCodes(user.id);
    return this.toAuthUser(user, roles);
  }

  /** 注册：查重 → 雪花 ID → bcrypt(cost=10) → 写库 → 绑默认角色 ROLE_USER */
  async register(input: {
    username: string;
    password: string;
    email?: string;
    realName?: string;
  }): Promise<{ userId: string }> {
    const exists = await this.findByUsername(input.username);
    if (exists) {
      throw new ConflictException('用户名已存在');
    }

    const userId = nextSnowflakeId();
    const user = this.userRepo.create({
      id: userId,
      username: input.username,
      password: await hash(input.password, 10),
      email: input.email ?? null,
      realName: input.realName ?? null,
      status: 1,
    });
    await this.userRepo.save(user);
    await this.assignRole(userId, RoleCode.USER);
    return { userId };
  }

  /** 绑角色（先查后插，重复绑定幂等跳过） */
  async assignRole(userId: string, roleCode: string): Promise<void> {
    const role = await this.roleRepo.findOne({ where: { roleCode } });
    if (!role) {
      throw new NotFoundException(`角色 ${roleCode} 不存在`);
    }
    const exists = await this.userRoleRepo.findOne({
      where: { userId, roleId: role.id },
    });
    if (exists) return;

    await this.userRoleRepo.save(
      this.userRoleRepo.create({
        id: nextSnowflakeId(),
        userId,
        roleId: role.id,
      }),
    );
  }

  /** 登录成功后更新最后登录时间 */
  async touchLastLogin(userId: string): Promise<void> {
    await this.userRepo.update(userId, { lastLoginAt: new Date() });
  }

  /** 按角色编码反查有效用户 ID 列表（审核员选择等场景） */
  async getUserIdsByRoleCode(roleCode: string): Promise<string[]> {
    const rows = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .innerJoin(UserEntity, 'u', 'u.id = ur.user_id')
      .where('r.role_code = :roleCode', { roleCode })
      .andWhere('u.deleted = false')
      .andWhere('u.status = 1')
      .select('u.id', 'userId')
      .getRawMany<{ userId: string | number }>();
    return rows.map((r) => String(r.userId));
  }
}
