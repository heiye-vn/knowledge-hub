# 站内通知（feat-v21）

> 模块范围：`kh_notification`、互动通知写入、管理员广播、未读角标与通知页。
> 代码路径：`apps/server/src/notification/*`、`document-social.service.ts`（notify）、
> `apps/web/src/pages/NotificationsPage.tsx`、`pages/admin/BroadcastPage.tsx`、`layouts/AppLayout.tsx`。

## 关键决策

### 1. 通知写入「尽力而为」

点赞/评论的核心结果是计数与内容，通知是派生数据。`notifyPerson` 内部 catch 全部异常并记 warn，
不让通知表故障把点赞/评论整体回滚。

### 2. 广播分批插入

管理员广播可能面向全量用户。服务端每 500 条 `save` 一次，避免单条 SQL 参数过多。
接收人支持 `userIds`；不传或空数组 = 所有 `deleted=false AND status=1` 的用户。

【易错】前端接收人下拉若仅静态加载前 100 个用户（`pageSize=100`），超过 100 人的组织里部分用户不可选。
本项目采用远程搜索防抖：`filterOption={false}` + `onSearch` 调 `/users/page?keyword=`，已选用户与搜索结果合并去重。

### 3. 角标刷新：轮询 + 本地事件

顶栏 30s 轮询未读数；通知页点开单条或「全部已读」后派发 `kh:notifications-changed`，
AppLayout 监听后立即重拉，避免必须等下一轮轮询。

### 4. 回复评论要通知被回复者

文档作者之外，被回复的评论作者也应收到通知（同一人只发一次）。
通知内容带文档标题 + 80 字评论摘要，点击跳转文档详情。

### 5. 点赞通知去重

同一发送人对同一文档的点赞只保留一条**未读**通知：`notifyLikeOnce()` 先按
`(userId, type=like, documentId, senderId, isRead=false)` 查重，存在则跳过。
点赞切换本身在文档行锁内串行化，因此这个「查未读再写」不会被同用户并发穿透；
用户读掉通知后再次点赞仍会产生新通知。

【实录】用户「赞 → 取消 → 赞」连续操作后，作者只收到 1 条未读点赞通知。

### 6. 顺手修复 `GET /users/page` 的响应键

联调广播接收人时发现服务端返回 `{ list, total }`，而前端 `PageResult` 约定是 `{ items, total }`，
用户管理页因此一直在读 `undefined`。本次统一改成 `items`，并同步 `UserService.pageUsers` 的返回类型。

【实录】广播页首版直接使用 `res.items`，页面白屏并报 `TypeError: res.items is not iterable`；
根因正是服务端 `list` 键与前端契约不一致。

## 验证

- 单测：`notification.service.spec.ts`（默认未读 + 截断、越权已读 404、全部已读只影响本人、广播全体、空标题 400、点赞未读去重、已读后可再次通知）。
- 联调：用户点赞/评论 → 作者未读数增加；管理员回复评论 → 被回复者收到通知；广播 3 人；赞→取消→赞只留 1 条未读点赞通知；全部已读后未读 0。
- 浏览器：铃铛角标 → 通知列表（未读/类型标签）→ 点击已读并跳转 → 全部已读；广播页接收人远程搜索。

## 已知局限

- 目前是 30s 轮询，不是 WebSocket/SSE 推送；需要毫秒级触达时再加长连接。
- 去重只覆盖「未读」点赞通知：用户读掉后再次点赞会再通知一次，这是有意的产品语义；若希望更强抑制，可按天窗口去重。
- 广播没有撤回/已读统计；通知表没有过期清理策略，后续按时间分区或定期归档。
