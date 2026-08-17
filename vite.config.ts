import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    // Artifact 배포용으로 단일 파일 인라인이 쉬워지도록 청크를 쪼개지 않는다.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
})
