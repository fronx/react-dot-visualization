import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
    })
  ],
  build: {
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.js'),
        'decollision-bench': path.resolve(__dirname, 'src/decollision-bench-entry.js'),
        'dotviz-bench': path.resolve(__dirname, 'src/dotviz-bench-entry.js')
      },
      name: 'ReactDotVisualization',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'es.js' : 'js'}`
    },
    rollupOptions: {
      external: [
        'react', 'react-dom', 'react/jsx-runtime',
        'three', '@react-three/fiber', '@react-three/drei', 'three-text',
        /^three\/.*/,
        /^@react-three\/.*/,
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          three: 'THREE',
        }
      }
    },
    sourcemap: true,
    minify: false
  }
})
