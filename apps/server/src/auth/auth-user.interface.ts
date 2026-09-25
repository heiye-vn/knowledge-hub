/** JWT 校验后注入到 Controller 的当前用户（不含密码等敏感字段） */
export interface AuthUser {
  userId: string;
  username: string;
  realName?: string | null;
  email?: string | null;
  avatar?: string | null;
  /** 角色编码列表（ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER） */
  roles: string[];
}
