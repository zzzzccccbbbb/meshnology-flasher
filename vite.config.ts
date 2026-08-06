import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        assetFileNames: (info) => {
          if (info.name && info.name.endsWith('.css')) return 'app.css';
          return '[name][extname]';
        },
      },
    },
  },
});
