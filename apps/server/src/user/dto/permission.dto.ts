import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PermissionType } from '../../common/constants/permissions.js';

export class CreatePermissionDto {
  /** 权限名称（展示用） */
  @IsString()
  @MaxLength(50)
  permissionName: string;

  /** 权限编码：鉴权唯一依据，建议「模块:动作」格式（如 document:export） */
  @IsString()
  @MaxLength(100)
  permissionCode: string;

  /** 权限类型：1 菜单 2 按钮 3 接口 */
  @Type(() => Number)
  @IsInt()
  @IsIn([PermissionType.Menu, PermissionType.Button, PermissionType.Api])
  permissionType: PermissionType;

  /** 父权限 ID（不传为根节点） */
  @IsOptional()
  @IsString()
  parentId?: string;

  /** 菜单路径（菜单级权限用） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  menuUrl?: string;

  /** 接口 URL 模式（接口级权限用） */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiUrl?: string;

  /** HTTP 方法（接口级权限用） */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  method?: string;

  /** 图标（菜单级权限用） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  /** 排序 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  /** 0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class UpdatePermissionDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  permissionName?: string;

  /** 【易错】权限编码变更不影响鉴权语义，但会影响已绑定的角色/用户生效路径 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  permissionCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([PermissionType.Menu, PermissionType.Button, PermissionType.Api])
  permissionType?: PermissionType;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  menuUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class QueryPermissionDto {
  /** 关键词（模糊匹配权限名称 / 编码） */
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/** 角色 / 用户绑定权限的整体替换入参 */
export class AssignPermissionIdsDto {
  /** 权限 ID 列表（整体替换语义：传空数组即清空绑定） */
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}
