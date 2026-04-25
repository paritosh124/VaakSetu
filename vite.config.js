import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Skip basicSsl when running inside `vercel dev` — vercel proxies HTTP only,
// and a Vite-served HTTPS endpoint causes TLS mismatch → 500 from the proxy.
// `vercel dev` sets VERCEL=1 in the spawned env.
const underVercel = process.env.VERCEL === '1';

export default defineConfig({
  plugins: [react(), ...(underVercel ? [] : [basicSsl()])],
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
      '/openai': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/openai/, ''),
      },
      '/groq': {
        target: 'https://api.groq.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/groq/, ''),
      },
      '/elevenlabs': {
        target: 'https://api.elevenlabs.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/elevenlabs/, ''),
      },
    },
  },
});
