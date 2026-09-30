import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { TeamEntity } from './entities/team.entity.js';
import { TeamMemberEntity } from './entities/team-member.entity.js';
import { UserEntity } from '../user/entities/user.entity.js';
import type {
  CreateTeamDto,
  QueryTeamDto,
  UpdateTeamDto,
} from './dto/team.dto.js';

/**
 * 团队服务：组织架构树 + 成员管理。
 *
 * 职责边界：只管 kh_team / kh_team_member 两表（及联查 kh_user 展示成员信息）；
 * 团队不参与 RBAC 鉴权，成员职务（member_role）与系统角色（kh_role）是两套概念。
 */
@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(TeamEntity)
    private readonly teamRepo: Repository<TeamEntity>,
    @InjectRepository(TeamMemberEntity)
    private readonly memberRepo: Repository<TeamMemberEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly em: EntityManager,
  ) {}

  async create(dto: CreateTeamDto) {
    if (dto.leaderId) {
      await this.ensureUserValid(dto.leaderId);
    }
    if (dto.parentId && dto.parentId !== '0') {
      const parent = await this.teamRepo.findOne({
        where: { id: dto.parentId, deleted: false },
      });
      if (!parent) throw new NotFoundException('指定的父团队不存在');
    }

    const team = this.teamRepo.create({
      id: nextSnowflakeId(),
      teamName: dto.teamName,
      teamCode: dto.teamCode ?? null,
      description: dto.description ?? null,
      leaderId: dto.leaderId ?? null,
      parentId: dto.parentId ?? '0',
      sort: dto.sort ?? 0,
      status: dto.status ?? 1,
    });
    return this.teamRepo.save(team);
  }

  async update(id: string, dto: UpdateTeamDto) {
    const team = await this.findByIdOrThrow(id);
    if (dto.leaderId !== undefined && dto.leaderId !== null) {
      await this.ensureUserValid(dto.leaderId);
    }
    if (dto.parentId !== undefined && dto.parentId !== team.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('父团队不能是自己');
      }
      if (dto.parentId !== '0') {
        const parent = await this.teamRepo.findOne({
          where: { id: dto.parentId, deleted: false },
        });
        if (!parent) throw new NotFoundException('指定的父团队不存在');
        const isDescendant = await this.isDescendantOf(dto.parentId, id);
        if (isDescendant) {
          throw new BadRequestException('父团队不能是自己的子团队');
        }
      }
      team.parentId = dto.parentId;
    }
    if (dto.teamName !== undefined) team.teamName = dto.teamName;
    if (dto.teamCode !== undefined) team.teamCode = dto.teamCode;
    if (dto.description !== undefined) team.description = dto.description;
    if (dto.leaderId !== undefined) team.leaderId = dto.leaderId;
    if (dto.sort !== undefined) team.sort = dto.sort;
    if (dto.status !== undefined) team.status = dto.status;
    return this.teamRepo.save(team);
  }

  /**
   * 软删团队并清成员绑定（两表写，em.transaction 保证原子性）。
   * 存在子团队时拒绝——先处理子级，避免树上出现孤儿节点。
   */
  async delete(id: string) {
    const team = await this.findByIdOrThrow(id);
    const childCount = await this.teamRepo.count({
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException('存在子团队，无法删除');
    }
    await this.em.transaction(async (tx) => {
      team.deleted = true;
      await tx.save(TeamEntity, team);
      await tx.delete(TeamMemberEntity, { teamId: id });
    });
  }

  /** 详情（附带成员数） */
  async getDetail(id: string) {
    const team = await this.findByIdOrThrow(id);
    const memberCount = await this.memberRepo.count({ where: { teamId: id } });
    return { ...team, memberCount };
  }

  async page(query: QueryTeamDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.teamRepo.createQueryBuilder('t').where('t.deleted = false');
    if (query.keyword?.trim()) {
      qb.andWhere('(t.team_name ILIKE :kw OR t.team_code ILIKE :kw)', {
        kw: `%${query.keyword.trim()}%`,
      });
    }
    if (query.status !== undefined) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    qb.orderBy('t.sort', 'ASC')
      .addOrderBy('t.created_at', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /**
   * 团队树（公开接口：注册页/筛选下拉等登录前场景也常用）。
   *
   * 【易错】按 parent_id 先分组（Map）再递归，而非每层 `teams.filter(...)`——
   * 后者是 O(n²)：每个节点都要扫一遍全量团队。Map 分组后整体 O(n)，
   * 组内顺序沿用查询的 sort / created_at 升序。
   */
  async getTree() {
    const teams = await this.teamRepo.find({
      where: { deleted: false, status: 1 },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
    const byParent = new Map<string, TeamEntity[]>();
    for (const t of teams) {
      const siblings = byParent.get(t.parentId);
      if (siblings) {
        siblings.push(t);
      } else {
        byParent.set(t.parentId, [t]);
      }
    }
    const build = (parentId: string): unknown[] =>
      (byParent.get(parentId) ?? []).map((t) => ({
        ...t,
        children: build(t.id),
      }));
    return build('0');
  }

  // ==================== 成员管理 ====================

  /**
   * 批量添加成员（幂等：已在团队的跳过）。
   * member_role 默认 member；负责人在团队表 leader_id 上体现，
   * 这里不自动写 leader，避免与 update 接口的赋值互相踩。
   */
  async addMembers(teamId: string, userIds: string[]) {
    await this.findByIdOrThrow(teamId);
    const unique = [...new Set(userIds)];
    const users = await this.userRepo.find({
      where: { id: In(unique), deleted: false },
    });
    if (users.length !== unique.length) {
      throw new NotFoundException('部分用户不存在');
    }
    // 只查「这批 userId 里已存在的」，命中 UNIQUE(team_id, user_id)；
    // 不要 find({ teamId }) 拉全量成员——千人团队会把整张关联表读进内存
    const existing = await this.memberRepo.find({
      where: { teamId, userId: In(unique) },
      select: { userId: true },
    });
    const existingIds = new Set(existing.map((m) => m.userId));
    const toAdd = unique.filter((userId) => !existingIds.has(userId));
    if (toAdd.length > 0) {
      await this.em.transaction(async (tx) => {
        const rows = toAdd.map((userId) => ({
          id: nextSnowflakeId(),
          teamId,
          userId,
          memberRole: 'member',
        }));
        await tx.insert(TeamMemberEntity, rows);
      });
    }
    return { added: toAdd.length, skipped: unique.length - toAdd.length };
  }

  async removeMembers(teamId: string, userIds: string[]) {
    await this.findByIdOrThrow(teamId);
    await this.memberRepo.delete({ teamId, userId: In(userIds) });
    return true;
  }

  /** 成员列表（联 kh_user 带出用户名/真实姓名） */
  async listMembers(teamId: string) {
    await this.findByIdOrThrow(teamId);
    return this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(UserEntity, 'u', 'u.id = m.user_id')
      .where('m.team_id = :teamId', { teamId })
      .andWhere('u.deleted = false')
      .select([
        'm.user_id AS "userId"',
        'm.member_role AS "memberRole"',
        'u.username AS "username"',
        'u.real_name AS "realName"',
      ])
      .getRawMany();
  }

  private async findByIdOrThrow(id: string) {
    const team = await this.teamRepo.findOne({
      where: { id, deleted: false },
    });
    if (!team) throw new NotFoundException('团队不存在');
    return team;
  }

  private async ensureUserValid(userId: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId, deleted: false },
      select: { id: true, status: true },
    });
    if (!user) {
      throw new NotFoundException('指定的负责人用户不存在');
    }
    if (user.status !== 1) {
      throw new BadRequestException('指定的负责人账户已被禁用');
    }
  }

  /**
   * 判断 targetId 是否是 ancestorId 的子孙团队（从 targetId 向上追溯父链）
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
      const node = await this.teamRepo.findOne({
        where: { id: currentId, deleted: false },
        select: { id: true, parentId: true },
      });
      if (!node) break;
      currentId = node.parentId;
    }
    return false;
  }
}
