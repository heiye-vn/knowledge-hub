# 文档分类（feat-v21）

> 模块范围：`kh_category` 建表与种子、`CategoryService` / `CategoryController`、文档创建/编辑的分类校验、列表/详情的分类名回填。
> 代码路径：`apps/server/src/document/category.service.ts`、`category.controller.ts`、`dto/category.dto.ts`、`entities/category.entity.ts`、
> `document.service.ts`（create / update / findAll / findOne）、`apps/web/src/pages/admin/CategoriesPage.tsx`、`utils.ts#flattenCategories`。

## 关键决策

### 1. 只新增一个权限码 `document:category`

基线实现为分类读/写和版本各加了一个权限码（`document:category` / `document:category:query` / `document:version`），
但 `document:list` 已经是所有能看文档的人的必备权限，`document:edit` 是作者的必备权限。再拆两个码不会改变任何人的实际访问范围，
只会让权限树多出两个永远无法独立生效的项。

主项目做法：
- 分类树：`@RequirePermission('document:list')`；
- 分类增删改：`@RequirePermission('document:category')`（管理员由 Guard 短路）；
- 版本读/回滚：`@RequirePermission('document:edit')` + 服务层 `canWriteDocument`。

【易错】新增权限码必须同时补 `ADMIN_OPERATION_PERMISSIONS`，否则管理员的 `/auth/me` 里没有该码，前端按权限码渲染的菜单会缺项。

### 2. 分类合法性校验下沉到服务层

`DocumentService.create/update` 统一调用 `CategoryService.normalize()`：
空值 / `'0'` 归一为 `null`，非空必须命中未删除分类，否则 400。
写入时不信任前端传的任意 bigint，避免出现指向不存在分类的悬空 `category_id`。

### 3. 树的两道防线

- 移动父级时沿 `parentId` 向上走，命中自身或形成环直接 400；
- 删除前检查「有子分类」和「仍有未删除文档引用」，任一命中拒绝删除。

【实录】前端父级下拉只排除自身是不够的：把父级选成自己的子分类会形成环，必须在服务端做整条祖先链检测。

### 4. 分类名回填避免 N+1

列表页一次性批量取当页 `categoryId` 的名字（`namesByIds`），详情页取单条。
前端列表新增「分类」列，搜索页把原来的「分类 ID」输入框换成下拉，编辑表单新增分类选择。

## 验证

- 单测：`category.service.spec.ts`（树构建、父级不存在、环检测、自引用、子分类/文档引用阻止删除、软删、normalize）。
- 联调：`POST /categories` → 创建文档带分类 → `GET /documents/:id` 回填 `categoryName` → 按 `categoryId` 筛选 → 删除分类返回 400（文档仍引用）→ 软删文档后可删分类。
- 浏览器：系统管理 → 分类管理新建/编辑/删除树表；文档列表筛选与分类列；编辑表单分类下拉。

## 已知局限

- 分类层级不限制深度（当前树小，前端全量加载够用）；分类量级变大后应改懒加载或按层级查询。
- 分类删除没有「批量迁移文档到其他分类」的交互，需要先逐篇改分类。
