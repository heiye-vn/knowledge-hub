import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      // Windows 下编辑器/工具非原子写入时，等待文件落盘稳定再触发转换，
      // 防止 Vite 在 truncate 瞬间读到 0 字节文件并缓存为空模块导致 default export 报错
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 20,
      },
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // SSE 流式连接不能被代理超时掐断
        timeout: 0,
        proxyTimeout: 0,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
