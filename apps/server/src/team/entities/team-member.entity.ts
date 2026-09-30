import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 团队-成员关联（PostgreSQL kh_team_member）。
 *
 * 团队 ↔ 用户多对多（一人可属多个团队）；(team_id, user_id) 唯一。
 * member_role 为团队内职务（leader / member），与系统级 RBAC 角色无关。
 */
@Entity('kh_team_member')
export class TeamMemberEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 团队 ID → kh_team.id */
  @Column({
    name: 'team_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  teamId: string;

  /** 用户 ID → kh_user.id */
  @Column({
    name: 'user_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  userId: string;

  /** 团队内职务（leader / member），与 RBAC 角色无关 */
  @Column({
    name: 'member_role',
    type: 'varchar',
    length: 20,
    default: 'member',
  })
  memberRole: string;

  /** 加入时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
