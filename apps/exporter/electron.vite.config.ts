import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import {resolve} from 'node:path'
export default defineConfig({
  main: { build: { externalizeDeps: true,rollupOptions:{input:{index:resolve('src/main/index.ts'),'preview-ledger':resolve('src/main/preview-ledger.ts')}} } },
  preload: { build: { rollupOptions: { output: { format: 'cjs' } } } },
  renderer: { plugins: [vue()] }
})
