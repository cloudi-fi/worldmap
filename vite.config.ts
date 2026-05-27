import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      name: 'WorldMap',
      formats: ['es', 'umd'],
      fileName: (format) => `worldmap.${format}.js`,
    },
    outDir: 'docs',
    emptyOutDir: true,
    sourcemap: false,
  },
})
