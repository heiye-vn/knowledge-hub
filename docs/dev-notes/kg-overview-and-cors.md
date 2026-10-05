# 全景图谱与跨域配置（kg-overview-and-cors）

> **模块范围**：
> - 服务端 CORS 跨域安全配置：`apps/server/src/main.ts`
> - 全景图谱数据检索与力导向图契约：`apps/server/src/kg/graph-build.service.ts`、`kg.controller.ts`、`dto/graph-query.dto.ts`、`types/kg.types.ts`
> - 接口测试集合与差异登记：`docs/apifox/knowledge-hub.postman_collection.json`、`docs/reference-mapping.md`

---

## 一、 为什么做这组改动

在进入前端工作台联调前，后端需要补齐两大前置基础设施：
1. **前后端跨域通信（CORS）**：前端独立端口（默认 `http://localhost:5173`）与服务端（默认 3000）通信时需携带认证凭证（Cookie/Bearer Token）。
2. **知识图谱全景视图（`GET /kg/overview`）**：供前端 ECharts 力导向图一次性拉取画布节点（文档、实体、标签）、拓扑边、统计指标、热门实体及分类，支持时间与关键词过滤。

---

## 二、 关键决策与相对基线实现的改进

| 关注点 | 基线实现做法 | 本项目做法 | 技术理由 |
| :--- | :--- | :--- | :--- |
| **CORS 跨域源** | `origin: true` 反射任意请求源 | 环境变量 `CORS_ORIGINS` 白名单配置（默认 `http://localhost:5173`） | 【缺陷层】`origin: true` 在带 `credentials: true` 时允许任意恶意网站跨域读取接口，存在严重安全隐患 |
| **图谱路由前缀** | `GET /graph/overview` | `GET /kg/overview` | 保持知识图谱域统一收敛在 `/kg/*` 路由命名空间下 |
| **异常可观测性** | catch 吞错返回空拓扑，仅打日志 | Neo4j 不可用抛 503，查询失败抛错交全局异常过滤器 | 避免前端在后端连接故障时展示一片空白却无从排查 |
| **标签节点支持** | 建图时写 tags | 建图 Cypher 同步增加 `d.tags = $tags` 持久化，并提供 splitTags 标签解析 | 丰富知识图谱网络密度，实现文档-标签拓扑关联 |
| **时间字段比较** | 直接字符串比较 | 兼容 Neo4j DateTime 与 ISO 字符串，使用 `toString(d.updatedAt)` 投影 | 消除数据库驱动返回格式不一致导致的字典序或精度问题 |

---

## 三、 验证闭环

1. **服务端检查**：
   - 类型检查：`pnpm typecheck:server` 通过（0 错误）。
   - 纯单元测试：`pnpm vitest run --exclude='**/*.e2e.spec.ts'` 24 个单测文件全部绿灯通过（169 passed）。
   - 代码规范检查：`pnpm --filter @knowledge-hub/server lint` 0 错误。
   - 编译构建：`pnpm build:server` 构建成功。
2. **前端界面检查**：
   - 权限守卫与路由：`document:list` 与 `document:edit` 路由门禁修复，`/graph` 与 `/dashboard` 完整接线。
   - 类型检查：`pnpm --filter @knowledge-hub/web typecheck` 通过（0 错误）。
   - 代码规范检查：`pnpm --filter @knowledge-hub/web lint` 通过（0 错误 0 告警）。
   - 生产打包构建：`pnpm --filter @knowledge-hub/web build` 构建成功。
