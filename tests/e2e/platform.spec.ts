/** @description E2E do que já existe em UI: /platform criar empresa + negação. */

import { expect, test } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import { PlatformPage } from "../pages/platform.page";
import { superAdminCredentials } from "./helpers/dev-vars";

const E2E_PASSWORD = "password-e2e-ok";

test.describe("Plataforma /platform", () => {
  test("super_admin vê formulário e cria empresa", async ({ page, context }) => {
    const { email, password } = superAdminCredentials();
    const login = new LoginPage(page);
    const platform = new PlatformPage(page);

    await context.clearCookies();
    await login.goto();
    await expect(login.emailInput).toBeVisible();
    await login.login(email, password);
    // SA often has zero memberships → shell without active empresa is OK
    await expect(page).not.toHaveURL(/\/login/);

    await platform.goto();
    await expect(platform.heading).toBeVisible({ timeout: 20_000 });

    const stamp = Date.now();
    const adminEmail = `e2e-new-admin-${stamp}@example.com`;
    await platform.createEmpresa({
      nome: `Casa E2E ${stamp}`,
      adminName: "Admin Novo E2E",
      adminEmail,
      adminPassword: E2E_PASSWORD,
    });

    await expect(platform.message).toContainText(/empresa criada/i);

    // Fresh session for the new house admin
    await context.clearCookies();
    await login.goto();
    await expect(login.emailInput).toBeVisible();
    await login.login(adminEmail, E2E_PASSWORD);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();
    // first admin of house → Admin nav
    await expect(
      page.locator('[data-sidebar="sidebar"]').getByRole("link", { name: /^admin$/i }),
    ).toBeVisible();
  });

  test("usuário comum recebe acesso negado em /platform", async ({ page }) => {
    const login = new LoginPage(page);
    const platform = new PlatformPage(page);

    await login.goto();
    await login.login("admin@e2e.local", E2E_PASSWORD);
    await expect(page).toHaveURL("/");

    await platform.goto();
    await expect(platform.deniedHeading).toBeVisible();
    await expect(
      page.getByText(/somente super_admin pode criar empresas/i),
    ).toBeVisible();
    await expect(platform.submitButton).toHaveCount(0);
  });

  test("sem sessão /platform mostra acesso negado (não vaza form)", async ({
    page,
  }) => {
    const platform = new PlatformPage(page);
    await page.context().clearCookies();
    await platform.goto();
    await expect(platform.deniedHeading).toBeVisible();
    await expect(platform.submitButton).toHaveCount(0);
  });
});
