import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const qaResultsDir = path.join(process.cwd(), "test-results", "accountant-qa");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(qaResultsDir, "playwright-results.json") }],
    ["html", { open: "never", outputFolder: path.join(process.cwd(), "playwright-report") }],
  ],
  outputDir: path.join(process.cwd(), "test-results", "playwright"),
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 1080 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
