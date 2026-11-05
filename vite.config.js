import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 构建环境里 node 的 copyFile 会被安全策略拒绝，允许用 VITE_NO_PUBLIC=1
  // 跳过 public 目录自动拷贝，改由构建脚本用 cp 复制
  publicDir: process.env.VITE_NO_PUBLIC ? false : 'public',
  build: {
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  optimizeDeps: {
    force: true
  },
  server: {
    force: true
  }
})
