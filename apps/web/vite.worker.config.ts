import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.VITE_PUBLIC_BASE ?? '/',
  build: {
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: 'src/notes-worker.ts',
      output: { entryFileNames: 'locho-notes-sw.js', inlineDynamicImports: true },
    },
  },
});
