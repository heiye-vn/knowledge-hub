import { ArrayNotEmpty, ArrayUnique, IsArray, IsString } from 'class-validator';

/** 管理员给用户分配角色入参（全量替换） */
export class AssignRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  roleCodes: string[];
}
