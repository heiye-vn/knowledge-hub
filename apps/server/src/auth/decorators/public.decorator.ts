import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** 标记接口无需 JWT（login / register / refresh / 健康检查等） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
