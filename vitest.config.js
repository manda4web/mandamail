import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/unit/**/*.test.js',
      'src/__tests__/properties/**/*.test.js',
      'src/__tests__/integration/**/*.test.js',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/__tests__/**'],
    },
  },
});
