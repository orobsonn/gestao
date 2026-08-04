/** @description Playwright global setup — seed e2e users against live local server. */

import { execFileSync } from "node:child_process";
import type { FullConfig } from "@playwright/test";

/**
 * @description Runs scripts/e2e-seed.mjs after webServer is up.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL?.toString() ?? "http://127.0.0.1:5173";

  // Ensure migrations on local D1 (idempotent)
  execFileSync("npm", ["run", "db:migrate:local"], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  execFileSync("node", ["scripts/e2e-seed.mjs"], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, E2E_BASE_URL: baseURL },
  });
}
