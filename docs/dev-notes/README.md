# 开发笔记（dev-notes）

> **这份文档解决什么问题**
>
> 记录每个功能模块在**编码过程中实际遇到的疑难问题、关键决策、易错点与改进点**。
> 它回答的是「**这行代码为什么长这样**」，而不是「这行代码做了什么」——
> 后者看代码本身和 [Apifox 接口集合](../apifox/) 就够了。
>
> **与 `docs/superpowers/specs/` 的区别**：spec 记录**计划中的设计**，
> 本目录记录**落地时的真实情况**（包括计划落空、被现实推翻的部分）。
> 两者不一致时，**以本目录为准**。

---

## 记录方式（增量追加）

**每完成一个功能模块，就为该模块新增一个记录文件**，不预先规划、不事后凭空补写。

```
完成 RAG 管线  → 新增 rag-pipeline.md
完成鉴权模块  → 新增 authentication.md
完成异步队列  → 新增 async-queue.md
...
```

理由：只有**正在写这段代码时**才清楚真正的坑在哪、为什么这么选。
事后回看代码补写的"注意事项"，往往变成泛泛而谈的正确废话。

---

## 已有记录

| 文件 | 类型 | 完成时间 | 核心看点 |
| :--- | :--- | :--- | :--- |
| [rag-pipeline.md](./rag-pipeline.md) | 功能模块 · RAG 索引与检索管线 | 2026-09-19 | **kNN 必然返回 topK 条**；IK 装了≠生效；原生 RRF 需商业 license；换模型必须重索引 |
| [async-reindex-pipeline.md](./async-reindex-pipeline.md) | 功能模块 · 异步重建索引管线（阶段二） | 2026-09-19 | **`new Queue()` 连不上也返回实例**（接口会假装可用）；连接错误刷屏需节流；实测证明单次发布不慢，故采用方案 B |
| [search-index.md](./search-index.md) | 功能模块 · 文档级搜索索引（ES `kh_document`） | 2026-09-20 | **两条索引可用性要分开判定**；同步 vs 异步按「单篇耗时」分层而非二选一；参考项目 v4 第二次没用 IK |
| [kg-graph.md](./kg-graph.md) | 功能模块 · KG 知识图谱（LLM 抽取 + Neo4j） | 2026-09-20 | **实测揪出三个真 bug**：先截断后校验误杀关系、跨块关系补不回、同形异码（⼯ U+2F2F）；单块抽取实测 19~57s，KG 必须异步 |
| [storage-single-postgres.md](./storage-single-postgres.md) | 功能模块 · 存储切换（PG+Mongo → 单 PG） | 2026-09-20 | **em.update() 不更新 @UpdateDateColumn**；并行 Edit 同一文件会互相覆盖；为一个集合养一整套数据库得不偿失 |
| [document-review-status.md](./document-review-status.md) | 功能模块 · 文档审核与四状态流转 | 2026-09-24 | **索引唯一入口是 Published**；审核流水与状态同事务、索引放事务外（失败可用 reindex 兜底）；待审唯一性必须下沉到部分唯一索引 |
| [image-document-parser.md](./image-document-parser.md) | 功能模块 · 图片文档多模态解析（VLM Qwen3.8-Flash） | 2026-09-24 | **VLM vs PaddleOCR**；Base64 避开内网访问壁垒；`VLM_API_KEY` 严格隔离；单测 Mock 保证 **0 Token 消耗** |
| [dual-storage-mode.md](./dual-storage-mode.md) | 功能模块 · 对象存储双模式（阿里云 OSS 与本地 RustFS） | 2026-09-24 | **零额外依赖（复用 S3 SDK）**；Virtual-Hosted 规范直链与 CDN；门面路由与历史代理兼容 |
| [authentication.md](./authentication.md) | 功能模块 · 用户鉴权（JWT 双令牌 + 全局守卫） | 2026-09-25 | **双令牌独立密钥**；登出吊销 Redis 黑名单（ioredis v6 无 waitUntilReady）；全局守卫「最小标注」原则；审核人从令牌取，不信前端 |
| [reference-project-alignment.md](./reference-project-alignment.md) | 方法论 · 与参考项目的对照策略 | 2026-09-19 | 三层判断法（模式/实现/缺陷）：什么照搬、什么可换、什么必须改 |


> 两类文件并存：
> **功能模块类**（做完一个模块记一个）记录实现过程中的坑；
> **方法论类**（如对照策略）记录讨论形成的**判断标准**——后者不随单个模块结束而失效。

---

## 新增一个模块记录时的约定

1. **文件名用功能模块名**（小写连字符），一个模块一个文件；不要把所有模块塞进一个文件，
   也不要把单个模块拆得过碎（按模块，不按子步骤）。
2. **标注来源**，便于后来者判断可信度：
   - **【实录】**：实际遇到并定位的问题，附真实报错信息与验证方法
   - **【易错】**：提炼出的风险点，尚未踩坑但值得预防
   - 不要把推测写成既成事实
3. **每条尽量写全**：现象 → 原因 → 解法 → **如何验证**。缺了「如何验证」价值大打折扣。
4. **涉及与参考项目 `knowledge-hub-backend` 的差异**，同时到
   [reference-mapping.md](../reference-mapping.md) 分叉表登记一行，本目录放更细的技术细节。
5. 文件开头写清**模块覆盖范围与对应代码路径**，结尾写**已知局限与后续待办**。
