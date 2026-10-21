import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // 真实 Neo4j / LLM 的集成用例走 vitest.config.e2e.ts，不能混进默认单测：
    // 它们共享外部状态、不可并行，且会消耗真实 token。
    exclude: ['**/node_modules/**', '**/dist/**', '**/*e2e*.spec.ts'],
    // 【易错】ES 集成用例（vector-index / retrieval）共用真实 kh_chunk 索引，
    // 用例内靠 beforeAll 删除 + bulk(refresh) 保证初始状态。并行跑时两套用例的
    // delete-by-query 与 bulk 会交叠，出现「删除已完成但读到旧快照」的偶发失败
    // （曾实测 vector-index 3 条用例偶发 expected 3 to be 2，单跑该文件则全绿）。
    // 关掉文件级并行换确定性：单测总量不大，串行仍在可接受量级。
    fileParallelism: false,
  },
});
