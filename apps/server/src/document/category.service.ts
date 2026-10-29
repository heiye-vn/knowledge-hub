import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { CategoryEntity } from './entities/category.entity.js';
import { DocumentEntity } from './entities/document.entity.js';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto.js';

export type CategoryNode = CategoryEntity & { children: CategoryNode[] };

/** 文档分类：树形结构、软删除；删除前必须清空子分类与文档引用 */
@Injectable()
export class CategoryService {
  constructor(@InjectEntityManager() private readonly em: EntityManager) {}

  /** 未删除分类按 sort、创建时间组成树；parentId 为空或 0 视为根 */
  async tree(): Promise<CategoryNode[]> {
    const rows = await this.em.find(CategoryEntity, {
      where: { deleted: false },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
    const byParent = new Map<string, CategoryEntity[]>();
    for (const row of rows) {
      const key = row.parentId && row.parentId !== '0' ? row.parentId : '0';
      const list = byParent.get(key) ?? [];
      list.push(row);
      byParent.set(key, list);
    }
    const build = (parentId: string): CategoryNode[] =>
      (byParent.get(parentId) ?? [])
        .slice()
        .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
        .map((row) => ({
          ...row,
          children: build(row.id),
        }));
    return build('0');
  }

  /** 批量取未删除分类名；空 ID、已删或不存在的不出现在结果里 */
  async namesByIds(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map();
    const rows = await this.em.find(CategoryEntity, {
      where: { id: In(unique), deleted: false },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** 空值表示"不分类"；非空时必须命中未删除分类 */
  async normalize(categoryId?: string | null): Promise<string | null> {
    const next = categoryId?.trim() || null;
    if (!next || next === '0') return null;
    await this.assertActive(next);
    return next;
  }

  /** 新建分类。未传 parentId 时挂到根（0） */
  async create(dto: CreateCategoryDto): Promise<CategoryEntity> {
    const parentId = await this.normalizeParent(dto.parentId);
    const row = this.em.create(CategoryEntity, {
      id: nextSnowflakeId(),
      name: dto.name.trim(),
      parentId,
      sort: dto.sort ?? 0,
      description: dto.description?.trim() || null,
      deleted: false,
    });
    return this.em.save(row);
  }

  /** 更新名称、排序、描述或父级；只改传入的字段 */
  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryEntity> {
    const row = await this.assertActive(id);
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.sort !== undefined) row.sort = dto.sort;
    if (dto.description !== undefined) {
      row.description = dto.description?.trim() || null;
    }
    if (dto.parentId !== undefined) {
      row.parentId = await this.normalizeParent(dto.parentId, id);
    }
    return this.em.save(row);
  }

  /** 软删除；仍有子分类或未删除文档时拒绝 */
  async remove(id: string): Promise<{ id: string }> {
    await this.assertActive(id);
    const child = await this.em.findOne(CategoryEntity, {
      where: { parentId: id, deleted: false },
    });
    if (child) throw new BadRequestException('请先删除子分类');
    const used = await this.em.count(DocumentEntity, {
      where: { categoryId: id, deleted: false },
    });
    if (used > 0) throw new BadRequestException('该分类下还有文档，不能删除');
    await this.em.update(CategoryEntity, { id }, { deleted: true });
    return { id };
  }

  private async assertActive(id: string): Promise<CategoryEntity> {
    const row = await this.em.findOne(CategoryEntity, {
      where: { id, deleted: false },
    });
    if (!row) throw new BadRequestException('分类不存在');
    return row;
  }

  /**
   * 规范化父级 ID：空值当成根 0。
   * 更新时禁止把自己或自己的子孙设为父级。
   */
  private async normalizeParent(
    parentId?: string | null,
    selfId?: string,
  ): Promise<string> {
    const next = parentId?.trim() || '0';
    if (next === '0') return '0';
    if (selfId && next === selfId) {
      throw new BadRequestException('不能把分类设为自己的子级');
    }
    await this.assertActive(next);
    if (selfId) {
      let cursor: string | null = next;
      const seen = new Set<string>();
      while (cursor && cursor !== '0') {
        if (cursor === selfId || seen.has(cursor)) {
          throw new BadRequestException('不能把分类移动到自己的子分类下');
        }
        seen.add(cursor);
        const parent: CategoryEntity | null = await this.em.findOne(
          CategoryEntity,
          { where: { id: cursor, deleted: false } },
        );
        cursor = parent?.parentId ?? null;
      }
    }
    return next;
  }
}
