import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  build: { format: 'file', inlineStylesheets: 'never' },
  compressHTML: false,
  devToolbar: { enabled: false },
});
