import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { UserEntity } from './entities/user.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { PermissionService } from './permission.service.js';
import { QueryUserDto } from './dto/query-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UpdateProfileDto } from './dto/profile.dto.js';
import { UserVO } from './vo/user.vo.js';

/**
 * 用户服务：账户与角色的读写。
 *
 * 职责边界：只管 kh_user / kh_role / kh_user_role 三表（及文档计数统计）；
 * Token 签发与校验在 AuthService，这里不感知 JWT；
 * 激活 token / 重置验证码在 auth 模块，这里只承接「校验通过后的落库」。
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
    @InjectRepository(DocumentEntity)
    private readonly documentRepo: Repository<DocumentEntity>,
    private readonly permissionService: PermissionService,
  ) {}

  /** 按用户名查未删除用户（软删数据不算，避免注册查重误判） */
  async findByUsername(username: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: { username, deleted: false },
    });
  }

  /** 按邮箱查未删除用户（重置密码 / 邮箱唯一性校验用） */
  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: { email, deleted: false },
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

  /**
   * Entity → 鉴权用视图对象（不含密码）。
   * permissions 由调用方传入（buildAuthUser / validateCredentials 先算好），
   * 本方法只做装配，不隐式查库——便于单测时直接构造 AuthUser。
   */
  toAuthUser(
    user: UserEntity,
    roles: string[],
    permissions: string[],
  ): AuthUser {
    return {
      userId: user.id,
      username: user.username,
      realName: user.realName,
      email: user.email,
      avatar: user.avatar,
      roles,
      permissions,
    };
  }

  /** Entity → 管理接口出参视图对象（脱敏：不含密码哈希） */
  async toUserVO(user: UserEntity): Promise<UserVO> {
    const roleCodes = await this.getRoleCodes(user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      realName: user.realName,
      avatar: user.avatar,
      status: user.status,
      emailVerified: user.emailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roleCodes,
    };
  }

  /** 按 ID 查出参视图对象（管理接口详情场景） */
  async toUserVOById(userId: string): Promise<UserVO> {
    return this.toUserVO(await this.findByIdOrThrow(userId));
  }

  /** 按 ID 重建当前用户信息（禁用账户拒绝），JwtStrategy / me / refresh 共用 */
  async buildAuthUser(userId: string): Promise<AuthUser> {
    const user = await this.findByIdOrThrow(userId);
    if (user.status !== 1) {
      throw new UnauthorizedException('账户已禁用');
    }
    const roles = await this.getRoleCodes(userId);
    // 复用上面已查到的 roles，避免权限服务再执行一次同样的角色联查
    const permissions =
      await this.permissionService.getUserPermissionCodes(userId, roles);
    return this.toAuthUser(user, roles, permissions);
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
    if (user.emailVerified === 0) {
      throw new UnauthorizedException('账户未激活，请先验证邮箱');
    }
    const ok = await compare(password, user.password);
    if (!ok) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const roles = await this.getRoleCodes(user.id);
    // 复用上面已查到的 roles，避免权限服务再执行一次同样的角色联查
    const permissions =
      await this.permissionService.getUserPermissionCodes(user.id, roles);
    return this.toAuthUser(user, roles, permissions);
  }

  /**
   * 注册：查重 → 雪花 ID → bcrypt(cost=10) → 写库 → 绑默认角色 ROLE_USER。
   * requireEmailVerification 为 true 时写入 email_verified=0（待激活），
   * 且 email 必填（由 AuthService 前置校验，这里防御性兜底）。
   */
  async register(input: {
    username: string;
    password: string;
    email?: string;
    realName?: string;
    requireEmailVerification?: boolean;
  }): Promise<{ userId: string; emailVerificationRequired: boolean }> {
    const exists = await this.findByUsername(input.username);
    if (exists) {
      throw new ConflictException('用户名已存在');
    }
    if (input.email) {
      const emailExists = await this.findByEmail(input.email);
      if (emailExists) {
        throw new ConflictException('该邮箱已被注册');
      }
    }
    const requireVerification = input.requireEmailVerification === true;
    if (requireVerification && !input.email) {
      throw new BadRequestException('开启邮箱验证时注册必须填写邮箱');
    }

    const userId = nextSnowflakeId();
    const user = this.userRepo.create({
      id: userId,
      username: input.username,
      password: await hash(input.password, 10),
      email: input.email ?? null,
      realName: input.realName ?? null,
      emailVerified: requireVerification ? 0 : 1,
      status: 1,
    });
    await this.userRepo.save(user);
    await this.assignRole(userId, RoleCode.USER);
    return { userId, emailVerificationRequired: requireVerification };
  }

  /** 邮箱激活落库：email_verified → 1 */
  async activateEmail(userId: string): Promise<string> {
    await this.userRepo.update(userId, { emailVerified: 1 });
    return '邮箱验证成功，请登录';
  }

  /** 按邮箱重置密码（验证码已由 auth 模块校验通过） */
  async resetPasswordByEmail(email: string, newPassword: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user) {
      throw new NotFoundException('该邮箱未注册');
    }
    await this.userRepo.update(user.id, {
      password: await hash(newPassword, 10),
      updatedAt: new Date(),
    });
  }

  /** 登录用户改密：校验旧密码后更新（em.update 不触发 @UpdateDateColumn，手动带） */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.findByIdOrThrow(userId);
    const ok = await compare(oldPassword, user.password);
    if (!ok) {
      throw new BadRequestException('原密码错误');
    }
    await this.userRepo.update(userId, {
      password: await hash(newPassword, 10),
      updatedAt: new Date(),
    });
  }

  /** 管理员重置指定用户密码（不需要旧密码） */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    await this.findByIdOrThrow(userId);
    await this.userRepo.update(userId, {
      password: await hash(newPassword, 10),
      updatedAt: new Date(),
    });
  }

  /** 登录用户更新自己的资料（username/password/status 不在此改） */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserVO> {
    const user = await this.findByIdOrThrow(userId);
    await this.userRepo.update(userId, {
      realName: dto.realName ?? user.realName,
      avatar: dto.avatar ?? user.avatar,
      updatedAt: new Date(),
    });
    return this.toUserVO(await this.findByIdOrThrow(userId));
  }

  /** 用户文档统计（我的贡献计数） */
  async getUserStatistics(userId: string): Promise<{ documentCount: number }> {
    const documentCount = await this.documentRepo.count({
      where: { createBy: userId },
    });
    return { documentCount };
  }

  /** 管理员分页查询用户（关键字模糊匹配用户名/姓名/邮箱，status 精确过滤） */
  async pageUsers(query: QueryUserDto): Promise<{
    list: UserVO[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const qb = this.userRepo
      .createQueryBuilder('u')
      .where('u.deleted = false')
      .orderBy('u.created_at', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize);

    if (query.keyword) {
      qb.andWhere(
        '(u.username LIKE :kw OR u.real_name LIKE :kw OR u.email LIKE :kw)',
        { kw: `%${query.keyword}%` },
      );
    }
    if (query.status !== undefined) {
      qb.andWhere('u.status = :status', { status: query.status });
    }

    const [users, total] = await qb.getManyAndCount();
    const list = await Promise.all(users.map((u) => this.toUserVO(u)));
    return { list, total, page: query.page, pageSize: query.pageSize };
  }

  /** 管理员新建用户（初始密码必填，可指定角色；默认绑 ROLE_USER） */
  async createUser(dto: CreateUserDto): Promise<string> {
    const exists = await this.findByUsername(dto.username);
    if (exists) {
      throw new ConflictException('用户名已存在');
    }
    if (dto.email) {
      const emailExists = await this.findByEmail(dto.email);
      if (emailExists) {
        throw new ConflictException('该邮箱已被注册');
      }
    }

    const userId = nextSnowflakeId();
    const user = this.userRepo.create({
      id: userId,
      username: dto.username,
      password: await hash(dto.password, 10),
      email: dto.email ?? null,
      realName: dto.realName ?? null,
      avatar: dto.avatar ?? null,
      emailVerified: 1,
      status: dto.status ?? 1,
    });
    await this.userRepo.save(user);

    const roleCodes = dto.roleCodes?.length ? dto.roleCodes : [RoleCode.USER];
    for (const code of roleCodes) {
      await this.assignRole(userId, code);
    }
    return userId;
  }

  /** 管理员更新用户（邮箱/username 唯一性校验；密码不在此改） */
  async updateUser(id: string, dto: UpdateUserDto): Promise<UserVO> {
    const user = await this.findByIdOrThrow(id);
    if (dto.username && dto.username !== user.username) {
      const exists = await this.findByUsername(dto.username);
      if (exists) {
        throw new ConflictException('用户名已存在');
      }
    }
    if (dto.email && dto.email !== user.email) {
      const emailExists = await this.findByEmail(dto.email);
      if (emailExists) {
        throw new ConflictException('该邮箱已被注册');
      }
    }

    await this.userRepo.update(id, {
      username: dto.username ?? user.username,
      email: dto.email ?? user.email,
      realName: dto.realName ?? user.realName,
      avatar: dto.avatar ?? user.avatar,
      status: dto.status ?? user.status,
      updatedAt: new Date(),
    });
    return this.toUserVO(await this.findByIdOrThrow(id));
  }

  /** 管理员删除用户：软删（文档保留创建人痕迹，硬删会断外键） */
  async deleteUser(id: string): Promise<void> {
    await this.findByIdOrThrow(id);
    await this.userRepo.update(id, { deleted: true, updatedAt: new Date() });
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

  /** 全量替换用户角色（分配前校验角色均存在且启用） */
  async replaceRoles(userId: string, roleCodes: string[]): Promise<string[]> {
    await this.findByIdOrThrow(userId);

    const roles = await this.roleRepo.find({
      where: { roleCode: In(roleCodes) },
    });
    const foundCodes = new Set(roles.map((r) => r.roleCode));
    const missing = roleCodes.filter((c) => !foundCodes.has(c));
    if (missing.length > 0) {
      throw new NotFoundException(`角色不存在：${missing.join(', ')}`);
    }
    const disabled = roles.filter((r) => r.status !== 1);
    if (disabled.length > 0) {
      throw new BadRequestException(
        `角色已禁用：${disabled.map((r) => r.roleCode).join(', ')}`,
      );
    }

    await this.userRoleRepo.delete({ userId });
    for (const role of roles) {
      await this.userRoleRepo.save(
        this.userRoleRepo.create({
          id: nextSnowflakeId(),
          userId,
          roleId: role.id,
        }),
      );
    }
    return this.getRoleCodes(userId);
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
