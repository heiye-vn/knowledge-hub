import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto.js';

/**
 * 管理员更新用户入参：全部可选；password 不允许通过此接口改
 *（改密走 /users/password/change 或管理员 /users/:id/password/reset）。
 */
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password', 'roleCodes'] as const),
) {}
