import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./generated-tests",
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "html" : "list",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
