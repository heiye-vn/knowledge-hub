import { describe, it, expect } from 'vitest';
import {
  accessFromUser,
  canReadDocument,
  canWriteDocument,
  esVisibilityFilter,
  wrapEsQuery,
  neo4jAccessParams,
  neo4jDocumentAccessWhere,
  neo4jRelationAccessWhere,
  ES_VISIBILITY_FIELDS,
} from './document-access.js';
import { DocumentStatus } from './document-status.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

describe('document-access', () => {
  const normalUser: AuthUser = {
    userId: '100',
    username: 'alice',
    roles: [RoleCode.USER],
    permissions: [],
    teamIds: ['team-1', 'team-2'],
  };

  const adminUser: AuthUser = {
    userId: '1',
    username: 'admin',
    roles: [RoleCode.ADMIN],
    permissions: ['*'],
    teamIds: [],
  };

  const reviewerUser: AuthUser = {
    userId: '2',
    username: 'reviewer',
    roles: [RoleCode.REVIEWER],
    permissions: [],
    teamIds: [],
  };

  describe('accessFromUser', () => {
    it('普通用户提取 userId、teamIds，且 unrestricted 为 false', () => {
      const scope = accessFromUser(normalUser);
      expect(scope).toEqual({
        unrestricted: false,
        userId: '100',
        teamIds: ['team-1', 'team-2'],
      });
    });

    it('管理员或审核员 unrestricted 为 true', () => {
      expect(accessFromUser(adminUser).unrestricted).toBe(true);
      expect(accessFromUser(reviewerUser).unrestricted).toBe(true);
    });
  });

  describe('canReadDocument', () => {
    it('管理员/审核员无限制放行', () => {
      const scope = accessFromUser(adminUser);
      expect(
        canReadDocument(
          {
            authorId: '999',
            teamId: null,
            isPublic: false,
            status: DocumentStatus.Draft,
          },
          scope,
        ),
      ).toBe(true);
    });

    it('作者本人可读任何状态的文档（包含草稿/待审/归档）', () => {
      const scope = accessFromUser(normalUser);
      expect(
        canReadDocument(
          {
            authorId: '100',
            teamId: null,
            isPublic: false,
            status: DocumentStatus.Draft,
          },
          scope,
        ),
      ).toBe(true);
      expect(
        canReadDocument(
          {
            authorId: '100',
            teamId: 'other-team',
            isPublic: false,
            status: DocumentStatus.PendingReview,
          },
          scope,
        ),
      ).toBe(true);
    });

    it('非作者且非已发布文档不可读', () => {
      const scope = accessFromUser(normalUser);
      expect(
        canReadDocument(
          {
            authorId: '999',
            teamId: 'team-1',
            isPublic: true,
            status: DocumentStatus.Draft,
          },
          scope,
        ),
      ).toBe(false);
    });

    it('已发布公开文档对登录用户可读', () => {
      const scope = accessFromUser(normalUser);
      expect(
        canReadDocument(
          {
            authorId: '999',
            teamId: null,
            isPublic: true,
            status: DocumentStatus.Published,
          },
          scope,
        ),
      ).toBe(true);
    });

    it('已发布且属于所在团队的文档可读', () => {
      const scope = accessFromUser(normalUser);
      expect(
        canReadDocument(
          {
            authorId: '999',
            teamId: 'team-1',
            isPublic: false,
            status: DocumentStatus.Published,
          },
          scope,
        ),
      ).toBe(true);
    });

    it('已发布但属于其他团队且非公开的文档不可读', () => {
      const scope = accessFromUser(normalUser);
      expect(
        canReadDocument(
          {
            authorId: '999',
            teamId: 'team-999',
            isPublic: false,
            status: DocumentStatus.Published,
          },
          scope,
        ),
      ).toBe(false);
    });
  });

  describe('canWriteDocument', () => {
    it('系统管理员拥有写权限', () => {
      expect(canWriteDocument({ authorId: '999' }, adminUser)).toBe(true);
    });

    it('作者本人拥有写权限', () => {
      expect(canWriteDocument({ authorId: '100' }, normalUser)).toBe(true);
    });

    it('非作者普通用户无写权限', () => {
      expect(canWriteDocument({ authorId: '999' }, normalUser)).toBe(false);
    });
  });

  describe('esVisibilityFilter', () => {
    it('unrestricted 作用域返回 null', () => {
      expect(
        esVisibilityFilter(accessFromUser(adminUser), ES_VISIBILITY_FIELDS),
      ).toBeNull();
    });

    it('有团队的用户生成包含 is_public、author_id 和 team_id 的 should 子句', () => {
      const scope = accessFromUser(normalUser);
      const filter = esVisibilityFilter(scope, ES_VISIBILITY_FIELDS);
      expect(filter).toEqual({
        bool: {
          should: [
            { term: { is_public: true } },
            { term: { author_id: '100' } },
            { terms: { team_id: ['team-1', 'team-2'] } },
          ],
          minimum_should_match: 1,
        },
      });
    });

    it('无团队的用户生成不含 team_id 的 should 子句', () => {
      const userWithoutTeams: AuthUser = { ...normalUser, teamIds: [] };
      const scope = accessFromUser(userWithoutTeams);
      const filter = esVisibilityFilter(scope, ES_VISIBILITY_FIELDS);
      expect(filter).toEqual({
        bool: {
          should: [
            { term: { is_public: true } },
            { term: { author_id: '100' } },
          ],
          minimum_should_match: 1,
        },
      });
    });
  });

  describe('wrapEsQuery', () => {
    const baseQuery = { match_all: {} };

    it('无 filter 时原样返回 query', () => {
      expect(wrapEsQuery(baseQuery, null)).toBe(baseQuery);
    });

    it('有 filter 时包裹为 bool.must + bool.filter', () => {
      const filter = { term: { is_public: true } };
      expect(wrapEsQuery(baseQuery, filter)).toEqual({
        bool: {
          must: [baseQuery],
          filter: [filter],
        },
      });
    });
  });

  describe('neo4jAccessParams & neo4jDocumentAccessWhere', () => {
    it('生成正确的 Cypher 参数', () => {
      const scope = accessFromUser(normalUser);
      expect(neo4jAccessParams(scope)).toEqual({
        unrestricted: false,
        accessUserId: '100',
        accessTeamIds: ['team-1', 'team-2'],
        publishedStatus: DocumentStatus.Published,
      });
      expect(neo4jAccessParams(undefined)).toEqual({
        unrestricted: true,
        accessUserId: '',
        accessTeamIds: [],
        publishedStatus: DocumentStatus.Published,
      });
    });

    it('生成带发布状态与可见性的 Cypher 过滤子句', () => {
      expect(neo4jDocumentAccessWhere('d')).toBe(
        '(d.status = $publishedStatus AND ($unrestricted OR d.authorId = $accessUserId OR d.isPublic = true OR d.teamId IN $accessTeamIds))',
      );
      expect(neo4jDocumentAccessWhere('n')).toBe(
        '(n.status = $publishedStatus AND ($unrestricted OR n.authorId = $accessUserId OR n.isPublic = true OR n.teamId IN $accessTeamIds))',
      );
    });

    it('关系可见性严格沿 sourceChunkIds 回查来源文档', () => {
      expect(neo4jRelationAccessWhere('r')).toBe(
        'EXISTS { MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(c:DocumentChunk) ' +
          'WHERE c.chunkId IN coalesce(r.sourceChunkIds, []) ' +
          'AND (d.status = $publishedStatus AND ($unrestricted OR d.authorId = $accessUserId OR d.isPublic = true OR d.teamId IN $accessTeamIds)) }',
      );
    });
  });
});
