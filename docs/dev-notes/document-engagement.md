# 文档互动：点赞 / 收藏 / 评论（feat-v21）

> 模块范围：`kh_document_like` / `kh_document_favorite` / `kh_comment`、互动服务与接口、详情页互动组件、我的收藏页。
> 代码路径：`apps/server/src/document/document-social.service.ts`、`document-engagement.controller.ts`、
> `dto/social.dto.ts`、`apps/web/src/components/DocumentEngagement.tsx`、`pages/FavoritesPage.tsx`。

## 关键决策

### 1. 计数列与互动行同事务 + 文档行锁

点赞/收藏/评论都在一个事务里完成：
`SELECT ... FOR UPDATE` 锁文档行 → 查/写互动行 → 更新 `kh_document` 的计数列。

【实录】基线实现是「查 → 算 → 写绝对值」，两个用户同时点赞会互相覆盖（5 → 6 → 6）；
连续双击还会同时通过「不存在」判断，撞 `(document_id, user_id)` 唯一键直接 500。
行锁把同一篇文档的互动串行化，唯一键仍是最后一道防线，但不再把并发暴露成 500。

### 2. 收藏列表的可见性条件下推到 SQL

第一版尝试 `innerJoin` 原始收藏表后 `getManyAndCount()`，TypeORM 分页会生成
`distinctAlias.fav_created_at`，实测报 `column distinctAlias.fav_created_at does not exist`。

改成两步：
1. 一条 SQL 取出当页的文档 ID（join 收藏表 + 可见性条件 + `order by fav.created_at` + `offset/limit`）；
2. 按 ID 回表取文档，保持收藏时间顺序。

【易错】`getManyAndCount` + 非实体 join alias 的排序字段在 TypeORM 里不可靠；要分页就 `getRawMany` + 单独 `getCount`。

### 3. 评论只做一层回复

`parentId` 只能指向顶层评论；回复评论会 400。前端只给顶层评论显示「回复」。
删除顶层评论时连带软删回复，并按实际删除条数回退评论数。

### 4. 通知放在事务之后

互动写库成功后再发通知，通知失败只记 warn（`notifyAuthor` / `notifyPerson` 内部 catch）。
回复评论时同时通知文档作者与被回复者，两者相同则只发一次。

### 5. 详情接口一次返回 `liked` / `favorited`

`GET /documents/:id` 合并互动标记，前端不用为两个按钮再发额外请求。

## 验证

- 单测：`document-social.service.spec.ts`（点赞切换与通知、自己赞自己不通知、收藏不通知、只能回复顶层、回复双通知、删父连带删回复、非作者删评论 403）。
- 联调：用户点赞/取消/再点赞 → 计数正确；收藏列表命中；评论 + 回复 → 作者通知 2 条、被回复者 1 条；详情返回 liked/favorited。
- 浏览器：详情页点赞/收藏按钮状态、评论列表与回复、我的收藏表格。

## 已知局限

- 同一用户反复赞/取消赞会产生多条点赞通知（未做去重）；量级大时可在通知表按 `(user_id, type, document_id, sender_id, is_read)` 去重。
- 评论没有分页，超长评论区一次全量返回；当前按文档详情页使用场景可接受。
- 互动的读权限跟随文档可见性：文档转为私有后，历史点赞/评论仍留在表里，但列表不再展示。
