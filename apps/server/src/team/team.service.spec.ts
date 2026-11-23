import { describe, expect, it, vi } from 'vitest';
import { TeamService } from './team.service.js';

describe('TeamService.page', () => {
  it('分页返回团队时批量聚合回填 memberCount，未匹配成员默认 0', async () => {
    const teamQb = {
      where: vi.fn(() => teamQb),
      andWhere: vi.fn(() => teamQb),
      orderBy: vi.fn(() => teamQb),
      addOrderBy: vi.fn(() => teamQb),
      skip: vi.fn(() => teamQb),
      take: vi.fn(() => teamQb),
      getManyAndCount: vi.fn(async () => [
        [
          { id: '101', teamName: '技术中心', teamCode: 'TECH' },
          { id: '102', teamName: '运营中心', teamCode: null },
        ],
        2,
      ]),
    };
    const memberQb = {
      select: vi.fn(() => memberQb),
      addSelect: vi.fn(() => memberQb),
      where: vi.fn(() => memberQb),
      groupBy: vi.fn(() => memberQb),
      getRawMany: vi.fn(async () => [{ teamId: '101', cnt: '3' }]),
    };
    const teamRepo = { createQueryBuilder: vi.fn(() => teamQb) };
    const memberRepo = { createQueryBuilder: vi.fn(() => memberQb) };
    const service = new TeamService(
      teamRepo as never,
      memberRepo as never,
      {} as never,
      {} as never,
    );

    const res = await service.page({ page: 1, pageSize: 10 });
    expect(res.total).toBe(2);
    expect(res.items).toEqual([
      { id: '101', teamName: '技术中心', teamCode: 'TECH', memberCount: 3 },
      { id: '102', teamName: '运营中心', teamCode: null, memberCount: 0 },
    ]);
  });
});
