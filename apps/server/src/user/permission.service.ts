import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import {
  ADMIN_OPERATION_PERMISSIONS,
  ADMIN_ROLES,
  PERMISSION_WILDCARD,
  RESERVED_PERMISSION_CODES,
} from '../common/constants/permissions.js';
import { PermissionEntity } from './entities/permission.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { UserPermissionEntity } from './entities/user-permission.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import type {
  AssignPermissionIdsDto,
  CreatePermissionDto,
  QueryPermissionDto,
  UpdatePermissionDto,
} from './dto/permission.dto.js';

/**
 * 权限服务：kh_permission 树 CRUD + 角色/用户绑定 + 用户权限码合并。
 *
 * 职责边界：只管三张权限相关表（kh_permission / kh_role_permission /
 * kh_user_permission）及与 kh_role / kh_user_role 的联查；
 * 用户/角色自身的 CRUD 在 UserService / RoleService。
 */
@Injectable()
export class PermissionService {
  constructor(
    @InjectRepository(PermissionEntity)
    private readonly permRepo: Repository<PermissionEntity>,
    @InjectRepository(RolePermissionEntity)
    private readonly rolePermRepo: Repository<RolePermissionEntity>,
    @InjectRepository(UserPermissionEntity)
    private readonly userPermRepo: Repository<UserPermissionEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoleRepo: Repository<UserRoleEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    private readonly em: EntityManager,
  ) {}

  // ==================== 权限树查询 ====================

  /** 全量有效权限（无分页，给前端权限树/下拉用） */
  async listAll() {
    return this.permRepo.find({
      where: { deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
  }

  async getById(id: string) {
    const perm = await this.permRepo.findOne({
      where: { id, deleted: false },
    });
    if (!perm) throw new NotFoundException('权限不存在');
    return perm;
  }

  /** 获取指定父权限下的直接有效子权限（走 parent_id 索引直查） */
  async getChildren(parentId: string) {
    return this.permRepo.find({
      where: { parentId, deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * 树形结构：parent_id 仅分类用途，children 不继承权限。
   *
   * 【易错】构造方式按 parent_id 先分组（Map）再递归，
   * 而不是每层 `perms.filter(...)` —— 后者是 O(n²)：
   * n 个节点每个都要扫一遍全表。Map 分组后整体 O(n)。
   * 依赖 listAll 的排序：同组内保持 sort / created_at 升序。
   */
  async getTree() {
    const perms = await this.listAll();
    const byParent = new Map<string, PermissionEntity[]>();
    for (const p of perms) {
      const siblings = byParent.get(p.parentId);
      if (siblings) {
        siblings.push(p);
      } else {
        byParent.set(p.parentId, [p]);
      }
    }
    const build = (parentId: string): unknown[] =>
      (byParent.get(parentId) ?? []).map((p) => ({
        ...p,
        children: build(p.id),
      }));
    return build('0');
  }

  async page(query: QueryPermissionDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.permRepo.createQueryBuilder('p').where('p.deleted = false');
    if (query.keyword?.trim()) {
      qb.andWhere(
        '(p.permission_name ILIKE :kw OR p.permission_code ILIKE :kw)',
        { kw: `%${query.keyword.trim()}%` },
      );
    }
    qb.orderBy('p.sort', 'ASC')
      .addOrderBy('p.created_at', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  // ==================== 权限 CRUD ====================

  async create(dto: CreatePermissionDto) {
    this.assertNotReserved(dto.permissionCode);
    const exists = await this.permRepo.findOne({
      where: { permissionCode: dto.permissionCode, deleted: false },
    });
    if (exists) throw new ConflictException('权限编码已存在');

    if (dto.parentId && dto.parentId !== '0') {
      const parent = await this.permRepo.findOne({
        where: { id: dto.parentId, deleted: false },
      });
      if (!parent) throw new NotFoundException('指定的父权限不存在');
    }

    const perm = this.permRepo.create({
      id: nextSnowflakeId(),
      parentId: dto.parentId ?? '0',
      permissionName: dto.permissionName,
      permissionCode: dto.permissionCode,
      permissionType: dto.permissionType,
      menuUrl: dto.menuUrl ?? null,
      apiUrl: dto.apiUrl ?? null,
      method: dto.method ?? null,
      icon: dto.icon ?? null,
      sort: dto.sort ?? 0,
      status: dto.status ?? 1,
    });
    return this.permRepo.save(perm);
  }

  async update(id: string, dto: UpdatePermissionDto) {
    const perm = await this.getById(id);
    if (dto.permissionCode && dto.permissionCode !== perm.permissionCode) {
      this.assertNotReserved(dto.permissionCode);
      const exists = await this.permRepo.findOne({
        where: { permissionCode: dto.permissionCode, deleted: false },
      });
      if (exists) throw new ConflictException('权限编码已存在');
      perm.permissionCode = dto.permissionCode;
    }
    if (dto.parentId !== undefined && dto.parentId !== perm.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('父权限不能是自己');
      }
      if (dto.parentId !== '0') {
        const parent = await this.permRepo.findOne({
          where: { id: dto.parentId, deleted: false },
        });
        if (!parent) throw new NotFoundException('指定的父权限不存在');
        const isDescendant = await this.isDescendantOf(dto.parentId, id);
        if (isDescendant) {
          throw new BadRequestException('父权限不能是自己的子权限');
        }
      }
      perm.parentId = dto.parentId;
    }
    if (dto.permissionName !== undefined) perm.permissionName = dto.permissionName;
    if (dto.permissionType !== undefined) perm.permissionType = dto.permissionType;
    if (dto.menuUrl !== undefined) perm.menuUrl = dto.menuUrl;
    if (dto.apiUrl !== undefined) perm.apiUrl = dto.apiUrl;
    if (dto.method !== undefined) perm.method = dto.method;
    if (dto.icon !== undefined) perm.icon = dto.icon;
    if (dto.sort !== undefined) perm.sort = dto.sort;
    if (dto.status !== undefined) perm.status = dto.status;
    return this.permRepo.save(perm);
  }

  /** 删除前置校验：有子权限、仍被角色/用户绑定 → 拒绝（避免悬空引用） */
  async delete(id: string) {
    const perm = await this.getById(id);
    const childCount = await this.permRepo.count({
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException('存在子权限，无法删除');
    }
    const roleBound = await this.rolePermRepo.count({
      where: { permissionId: id },
    });
    const userBound = await this.userPermRepo.count({
      where: { permissionId: id },
    });
    if (roleBound > 0 || userBound > 0) {
      throw new BadRequestException('权限仍被角色或用户引用，请先解绑');
    }
    perm.deleted = true;
    await this.permRepo.save(perm);
  }

  // ==================== 角色绑定 ====================

  async getRolePermissionIds(roleId: string): Promise<string[]> {
    await this.ensureRoleExists(roleId);
    const rows = await this.rolePermRepo.find({ where: { roleId } });
    return rows.map((r) => r.permissionId);
  }

  /**
   * 整体替换角色的权限绑定。
   *
   * 【实录·参考项目缺陷】参考项目 v9 为「delete 后循环 save」无事务，
   * 中途失败会留下「绑定被清空但没补回」的中间态；本项目包进
   * em.transaction，且组装为单个数组单次批量 insert，任一步失败整体回滚。
   */
  async assignRolePermissions(roleId: string, dto: AssignPermissionIdsDto) {
    await this.ensureRoleExists(roleId);
    await this.validatePermissionIds(dto.permissionIds);
    await this.em.transaction(async (tx) => {
      await tx.delete(RolePermissionEntity, { roleId });
      if (dto.permissionIds.length > 0) {
        const rows = dto.permissionIds.map((permissionId) => ({
          id: nextSnowflakeId(),
          roleId,
          permissionId,
        }));
        await tx.insert(RolePermissionEntity, rows);
      }
    });
    return dto.permissionIds;
  }

  // ==================== 用户直接赋权 ====================

  async getUserDirectPermissionIds(userId: string): Promise<string[]> {
    const rows = await this.userPermRepo.find({ where: { userId } });
    return rows.map((r) => r.permissionId);
  }

  /** 整体替换用户的直接权限（同样事务化 + 单次批量 insert，理由同上） */
  async assignUserPermissions(userId: string, dto: AssignPermissionIdsDto) {
    await this.validatePermissionIds(dto.permissionIds);
    await this.em.transaction(async (tx) => {
      await tx.delete(UserPermissionEntity, { userId });
      if (dto.permissionIds.length > 0) {
        const rows = dto.permissionIds.map((permissionId) => ({
          id: nextSnowflakeId(),
          userId,
          permissionId,
        }));
        await tx.insert(UserPermissionEntity, rows);
      }
    });
    return dto.permissionIds;
  }

  // ==================== 权限码合并（鉴权数据源） ====================

  /**
   * 合并用户的最终权限码集合：直接赋权 ∪ 角色间接权限；
   * 管理员再追加通配符与 ADMIN_OPERATION_PERMISSIONS 常量
   * （库里不给管理员逐条绑定）。
   *
   * 只并入 status=1 且未删除的权限——禁用一个权限即全局收权，
   * 不需要逐个解绑角色/用户。
   *
   * @param knownRoleCodes 调用方**已算好**的角色编码。
   *   【易错】`UserService.buildAuthUser` / `validateCredentials` 本来就要查一次
   *   角色（AuthUser.roles），不传进来这里会重复执行同一条 SQL。
   *   登录链路每请求都要走，能省一条是一条；不传则自行查询，保证可独立调用。
   */
  async getUserPermissionCodes(
    userId: string,
    knownRoleCodes?: string[],
  ): Promise<string[]> {
    const direct = await this.userPermRepo
      .createQueryBuilder('up')
      .innerJoin(PermissionEntity, 'p', 'p.id = up.permission_id')
      .where('up.user_id = :userId', { userId })
      .andWhere('p.status = 1')
      .andWhere('p.deleted = false')
      .select('p.permission_code', 'code')
      .getRawMany<{ code: string }>();

    const viaRole = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(RolePermissionEntity, 'rp', 'rp.role_id = ur.role_id')
      .innerJoin(PermissionEntity, 'p', 'p.id = rp.permission_id')
      .where('ur.user_id = :userId', { userId })
      .andWhere('p.status = 1')
      .andWhere('p.deleted = false')
      .select('DISTINCT p.permission_code', 'code')
      .getRawMany<{ code: string }>();

    const set = new Set<string>([
      ...direct.map((r) => r.code),
      ...viaRole.map((r) => r.code),
    ]);

    const roleCodes =
      knownRoleCodes ??
      (
        await this.userRoleRepo
          .createQueryBuilder('ur')
          .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
          .where('ur.user_id = :userId', { userId })
          .andWhere('r.status = 1')
          .select('r.role_code', 'roleCode')
          .getRawMany<{ roleCode: string }>()
      ).map((r) => r.roleCode);

    const isAdmin = roleCodes.some((roleCode) =>
      (ADMIN_ROLES as readonly string[]).includes(roleCode),
    );
    if (isAdmin) {
      // 1. 追加通配符 '*'：支持前端通过通配符直接放行动态创建的所有新菜单/按钮
      set.add(PERMISSION_WILDCARD);
      // 2. 追加具体常量权限池（保持向后兼容，供精确判断场景消费）
      for (const code of ADMIN_OPERATION_PERMISSIONS) {
        set.add(code);
      }
    }

    return [...set];
  }

  // ==================== 私有校验 ====================

  private async ensureRoleExists(roleId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('角色不存在');
  }

  /** 保留权限码不可作为业务权限编码写入 */
  private assertNotReserved(code: string) {
    if ((RESERVED_PERMISSION_CODES as readonly string[]).includes(code)) {
      throw new BadRequestException(
        `'${code}' 是系统保留权限码，不可作为业务权限使用`,
      );
    }
  }

  /**
   * 校验权限 ID 全部存在且有效。
   * 【实录·参考项目缺陷】参考项目用 found.length !== ids.length 判断，
   * 入参含重复 ID 时会误报 404；先去重再比对。
   */
  private async validatePermissionIds(ids: string[]) {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    const found = await this.permRepo.find({
      where: { id: In(unique), deleted: false, status: 1 },
    });
    if (found.length !== unique.length) {
      throw new NotFoundException('部分权限不存在或已禁用');
    }
  }

  /**
   * 判断 targetId 是否是 ancestorId 的子孙节点（从 targetId 向上追溯父链）
   */
  private async isDescendantOf(
    targetId: string,
    ancestorId: string,
  ): Promise<boolean> {
    let currentId = targetId;
    const visited = new Set<string>();
    while (currentId && currentId !== '0') {
      if (currentId === ancestorId) return true;
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const node = await this.permRepo.findOne({
        where: { id: currentId, deleted: false },
        select: { id: true, parentId: true },
      });
      if (!node) break;
      currentId = node.parentId;
    }
    return false;
  }
}
