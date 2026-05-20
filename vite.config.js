import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3011
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        canvas: resolve(__dirname, 'canvas.html'),
        webgl: resolve(__dirname, 'webgl.html'),
        webgpu: resolve(__dirname, 'webgpu.html'),
        'index-sigma': resolve(__dirname, 'index-sigma.html'),
        'performance-test': resolve(__dirname, 'performance-test.html'),
        'webgpu-spike': resolve(__dirname, 'webgpu-spike.html'),
      },
    },
  },
  test: {
    include: [
      'src/__tests__/**/*.{test,spec}.{js,mjs}',
      'tests/decollisionScheduler.test.mjs',
    ],
  }
})