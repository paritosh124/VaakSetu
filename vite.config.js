import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev proxy: routes /sarvam/* → https://api.sarvam.ai/*
    // This avoids CORS issues during local development.
    // For Vercel production, add /api/proxy.js (see README).
    proxy: {
      '/sarvam': {
        target: 'https://api.sarvam.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sarvam/, ''),
      },
    },
  },
});
