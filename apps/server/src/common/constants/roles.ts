/** 预置角色编码（与 kh_role.role_code 一致，RolesGuard 按此判断权限） */
export const RoleCode = {
  ADMIN: 'ROLE_ADMIN',
  REVIEWER: 'ROLE_REVIEWER',
  USER: 'ROLE_USER',
} as const;

export type RoleCodeValue = (typeof RoleCode)[keyof typeof RoleCode];
