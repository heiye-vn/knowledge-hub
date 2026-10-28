import { AiMessageEntity } from '../ai/entities/ai-message.entity.js';
import { AiSessionEntity } from '../ai/entities/ai-session.entity.js';
import { DocumentContentEntity } from '../document/entities/document-content.entity.js';
import { DocumentReviewEntity } from '../document/entities/document-review.entity.js';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { DocumentImportEntity } from '../document/entities/document-import.entity.js';
import { DocumentResourceEntity } from '../document/entities/document-resource.entity.js';
import { TeamMemberEntity } from '../team/entities/team-member.entity.js';
import { TeamEntity } from '../team/entities/team.entity.js';
import { PermissionEntity } from '../user/entities/permission.entity.js';
import { RolePermissionEntity } from '../user/entities/role-permission.entity.js';
import { RoleEntity } from '../user/entities/role.entity.js';
import { UserPermissionEntity } from '../user/entities/user-permission.entity.js';
import { UserRoleEntity } from '../user/entities/user-role.entity.js';
import { UserEntity } from '../user/entities/user.entity.js';
import { IndexOutboxEntity } from '../indexing/entities/index-outbox.entity.js';

/**
 * 实体清单（单一事实源）：
 * - 运行时 TypeOrmModule 与迁移 CLI 共用，避免两处各写一份导致漏登记；
 * - 【易错】`synchronize: false` 下新增实体若忘记登记，只有运行到该实体
 *   的仓储操作才会暴露（不在启动时报错），所以必须集中维护。
 */
export const ENTITIES = [
  DocumentEntity,
  DocumentImportEntity,
  DocumentResourceEntity,
  DocumentContentEntity,
  DocumentReviewEntity,
  UserEntity,
  RoleEntity,
  UserRoleEntity,
  PermissionEntity,
  RolePermissionEntity,
  UserPermissionEntity,
  TeamEntity,
  TeamMemberEntity,
  AiSessionEntity,
  AiMessageEntity,
  IndexOutboxEntity,
];
