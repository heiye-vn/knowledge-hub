import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { DocumentStatus } from './document-status.js';
import type { DocumentEntity } from './entities/document.entity.js';

/** 当前用户可读哪些文档：公开 ∪ 所在团队 ∪ 自己写的；管理员/审核员不限制 */
export type DocumentAccessScope = {
  unrestricted: boolean;
  userId: string;
  teamIds: string[];
};

export function accessFromUser(user: AuthUser): DocumentAccessScope {
  const roles = user.roles ?? [];
  return {
    unrestricted:
      roles.includes(RoleCode.ADMIN) || roles.includes(RoleCode.REVIEWER),
    userId: user.userId,
    teamIds: user.teamIds ?? [],
  };
}

export function canReadDocument(
  doc: Pick<DocumentEntity, 'authorId' | 'teamId' | 'isPublic' | 'status'>,
  scope: DocumentAccessScope,
): boolean {
  if (scope.unrestricted) return true;
  if (doc.authorId && doc.authorId === scope.userId) return true;
  if (doc.status !== DocumentStatus.Published) return false;
  if (doc.isPublic) return true;
  return Boolean(doc.teamId && scope.teamIds.includes(doc.teamId));
}

export function canWriteDocument(
  doc: Pick<DocumentEntity, 'authorId'>,
  user: AuthUser,
): boolean {
  if (user.roles?.includes(RoleCode.ADMIN)) return true;
  return Boolean(doc.authorId && doc.authorId === user.userId);
}

/** ES 索引字段映射（主项目统一采用 snake_case） */
export const ES_VISIBILITY_FIELDS = {
  isPublic: 'is_public',
  authorId: 'author_id',
  teamId: 'team_id',
} as const;

/**
 * Elasticsearch 可见性 filter（只筛不打分）。
 * 针对主项目统一使用 snake_case（is_public, author_id, team_id）。
 * 管理员/审核员返回 null，调用方不加过滤。
 */
export function esVisibilityFilter(
  scope: DocumentAccessScope,
  fields: { isPublic: string; authorId: string; teamId: string } = ES_VISIBILITY_FIELDS,
): Record<string, unknown> | null {
  if (scope.unrestricted) return null;
  // 公开 ∪ 自己写的；有团队再 OR 所在团队。
  const should: Record<string, unknown>[] = [
    { term: { [fields.isPublic]: true } },
    { term: { [fields.authorId]: scope.userId } },
  ];
  if (scope.teamIds.length) {
    should.push({ terms: { [fields.teamId]: scope.teamIds } });
  }
  // filter 上下文中 should = 或；至少命中一条才可见
  return { bool: { should, minimum_should_match: 1 } };
}

/** 相关性查询放 must，可见性放 filter，避免权限条件影响打分 */
export function wrapEsQuery(
  query: Record<string, unknown>,
  filter: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!filter) return query;
  return {
    bool: {
      must: [query],
      filter: [filter],
    },
  };
}

export function neo4jAccessParams(scope?: DocumentAccessScope) {
  return {
    unrestricted: !scope || scope.unrestricted,
    accessUserId: scope?.userId ?? '',
    accessTeamIds: scope?.teamIds ?? [],
  };
}

/** Cypher：文档节点是否对当前用户可见 */
export function neo4jDocumentAccessWhere(alias = 'd'): string {
  return (
    `($unrestricted OR ${alias}.authorId = $accessUserId ` +
    `OR ${alias}.isPublic = true OR ${alias}.teamId IN $accessTeamIds)`
  );
}
