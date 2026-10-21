import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // 两套命名并存：test/ 下的 *.e2e-spec.ts 与 src/ 下历史遗留的 *e2e*.spec.ts
    include: ['**/*.e2e-spec.ts', '**/*e2e*.spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
