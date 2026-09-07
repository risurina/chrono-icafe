import { defineConfig, devices } from "@playwright/test";

// Drives the real running dev servers (web :3000 + api :8787). Start them with
// `pnpm dev` first. Headed + slowMo so the run is visible.
export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localtest.me:3010",
    headless: false,
    viewport: { width: 1280, height: 800 },
    trace: "on",
    launchOptions: { slowMo: 350 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
