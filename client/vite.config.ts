import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VITE_API_TARGET || 'http://localhost:4000';

// In dev the browser talks only to Vite; /api and /socket.io are proxied to the backend so cookies stay same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/socket.io': { target: API, ws: true, changeOrigin: true },
    },
  },
});
