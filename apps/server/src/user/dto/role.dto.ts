import { PartialType } from '@nestjs/mapped-types';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/** 新建角色入参 */
export class CreateRoleDto {
  @IsString()
  @MaxLength(50)
  roleName: string;

  /** 角色编码（全局唯一，如 ROLE_EDITOR） */
  @IsString()
  @MaxLength(50)
  roleCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

/** 更新角色入参：全部可选 */
export class UpdateRoleDto extends PartialType(CreateRoleDto) {
  /** 0 禁用 1 启用（禁用后该角色立即不参与鉴权） */
  @IsOptional()
  @IsInt()
  status?: number;
}
