/**
 * 用户出参视图对象（VO）：管理接口返回结构，脱敏——不含密码哈希。
 * DTO 封装入参，VO 封装出参，两者分工见 dev-notes。
 */
export interface UserVO {
  id: string;
  username: string;
  email: string | null | undefined;
  realName: string | null | undefined;
  avatar: string | null | undefined;
  /** 0 禁用 1 启用 */
  status: number;
  /** 0 未验证 1 已验证 */
  emailVerified: number;
  lastLoginAt: Date | null | undefined;
  createdAt: Date;
  updatedAt: Date;
  roleCodes: string[];
}
