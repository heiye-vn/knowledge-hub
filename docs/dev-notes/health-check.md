# 健康检查（存活 / 就绪）

> 代码路径：`apps/server/src/health/`
> 端点：`GET /health`（存活）、`GET /health/ready`（就绪），均公开

## 一、为什么拆两个端点

**现象**：此前只有一个 `GET /health` 直接返回 `{ status: 'ok' }`，无论数据库是否可用都是 200。
容器编排据此判断"健康"，会在 PG 已经挂掉时继续把流量打进来，用户看到的是成片 500。

**解法**：

| 端点 | 语义 | 判定 |
| :--- | :--- | :--- |
| `/health` | 存活（liveness） | 进程能响应就是 200；不查依赖，避免依赖抖动导致容器被反复重启 |
| `/health/ready` | 就绪（readiness） | 真实探测 PG / Redis / ES / Neo4j |

## 二、必需与可选的区分

- **PostgreSQL 必需**：连接不可用 → `status: 'error'` + HTTP **503**（服务确实不可用）；
- **Redis / ES / Neo4j 可选**：任一不可用 → `status: 'degraded'` + HTTP **200**。
  原因是三者缺失时应用会降级运行（检索降级、图谱不可用、限流失效），
  不该因此把整个实例摘出负载均衡。

响应结构：

```json
{
  "status": "degraded",
  "checks": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "down", "latencyMs": 1502, "error": "探测超时（1500ms）" },
    "elasticsearch": { "status": "disabled" },
    "neo4j": { "status": "up", "latencyMs": 12 }
  }
}
```

`disabled` 表示配置层面关闭（`REDIS_ENABLED=false` 等），与 `down` 区分——
关闭是预期状态，不该让就绪探针长期 degraded。

## 三、探测必须带超时【易错】

ES / Neo4j 连接挂死时（TCP 已建立但对端无响应），直接 `await client.ping()` 会一直挂住，
就绪探针随之超时，编排系统误判实例不可用并重启——重启后仍然挂死，形成循环。

`HealthService.probe()` 用 `Promise.race` 加 `HEALTH_CHECK_TIMEOUT_MS`（默认 1500ms），
超时记为 `down` 而不是让整轮检查失败。

## 四、信封状态码的坑

`@Res({ passthrough: true })` 在 controller 里 `res.status(503)` 之后，
全局 `TransformInterceptor` 才把数据包成 `{ code, message, data }`。

**原实现的问题**：拦截器在 `next.handle()` 之前就读了 `response.statusCode`，
此时永远是 200，信封里的 `code` 与真实 HTTP 状态不一致，前端按 `code` 判断会误认为成功。

**修复**：把 `statusCode` 的读取挪到 `map()` 内部（handler 执行之后）。
`transform.interceptor.spec.ts` 用 `defer()` 模拟"handler 内改状态码"锁住这个行为。

## 五、依赖服务的配合改动

- `RedisService` 补 `isEnabled()`（配置层）与 `ping()`；
- `GraphBuildService` 补 `isEnabled()` 与 `ping()`（`driver.verifyConnectivity()`）；
- ES 复用已有的 `isEnabled()` + `client.ping()`。

三个服务都区分"配置启用"与"连接可用"：只有前者为假才标记 `disabled`。

## 六、验证方式

- 单测：`vitest run src/health src/common/interceptors`（service 5 + controller 4 + 拦截器 1）；
- 手工：`curl localhost:3000/health/ready`，停掉某个可选依赖应看到 `degraded` 而非 503；
- 停掉 PG 应看到 503（注意应用本身也会因连接池报错，属预期）。

## 七、已知局限

- 探测是**每次请求实时执行**，没有缓存；高频探针会给依赖带来额外压力，
  如遇探针风暴可加 5~10s 结果缓存。
- ES 的 `isEnabled()` 混入了连接状态，`disabled` 与 `down` 的边界不完全精确；
  要精确区分需要在 ES 服务里单独暴露配置位（当前 ES 未启用时记 `disabled` 已够用）。
