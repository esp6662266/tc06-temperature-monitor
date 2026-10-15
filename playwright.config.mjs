import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests',testMatch:'web.spec.mjs',fullyParallel:false,
  use:{baseURL:'http://127.0.0.1:8766',browserName:'chromium',channel:'chrome',serviceWorkers:'block'},
  webServer:{command:'node server/dev.mjs',url:'http://127.0.0.1:8766',reuseExistingServer:!process.env.CI},
});
