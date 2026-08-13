import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/plasmaviewer/',
  plugins: [react()],
  server: { host: true },
});
