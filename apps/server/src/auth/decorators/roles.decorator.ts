import { SetMetadata } from '@nestjs/common';
import type { RoleCodeValue } from '../../common/constants/roles.js';

export const ROLES_KEY = 'roles';

/** 要求用户拥有指定角色之一（配合 RolesGuard；未标注则仅要求已登录） */
export const Roles = (...roles: RoleCodeValue[]) =>
  SetMetadata(ROLES_KEY, roles);
