import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CategoryService } from './category.service.js';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * 分类接口。
 *
 * - 分类树：所有能看文档列表的用户都要用它做筛选/下拉，故只要求 document:list；
 * - 增删改：需 document:category（管理员由 PermissionsGuard 短路）。
 */
@Controller('categories')
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Get('tree')
  @RequirePermission('document:list')
  tree() {
    return this.categories.tree();
  }

  @Post()
  @RequirePermission('document:category')
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Put(':id')
  @RequirePermission('document:category')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('document:category')
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
