import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 300000,
    fileParallelism: false,
    env: { NODE_ENV: 'test', STORAGE_DIR: '.data/test-uploads', JWT_SECRET: 'test-secret-test-secret-123', CLIENT_URL: 'http://localhost:5173', MAX_AUDIO_MB: '1', ADMIN_EMAILS: 'root@admin.test,root2@admin.test' },
  },
});
