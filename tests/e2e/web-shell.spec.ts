/** @description E2E do casco web — login, empresa, nav, tema e Admin por papel. */

import { expect, test } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import { ShellPage } from "../pages/shell.page";

const PASSWORD = "password-e2e-ok";

test.describe("Casco web", () => {
  test("usuario admin com uma casa entra na Home e vê Admin", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();
    await expect(shell.homeNav).toBeVisible();
    await expect(shell.expertsNav).toBeVisible();
    await expect(shell.meuTrabalhoNav).toBeVisible();
    await expect(shell.adminNav).toBeVisible();

    await shell.adminNav.click();
    await expect(page.getByRole("heading", { name: /^admin$/i })).toBeVisible();
  });

  test("membro não vê Admin e é redirecionado se abrir /admin", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);

    await login.goto();
    await login.login("membro@e2e.local", PASSWORD);

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();
    await expect(shell.adminNav).toHaveCount(0);

    await page.goto("/admin");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();
  });

  test("multi-empresa escolhe casa no picker antes do casco", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);

    await login.goto();
    await login.login("multi@e2e.local", PASSWORD);

    await expect(shell.pickerTitle).toBeVisible();
    await shell.chooseEmpresa("Casa Alpha");

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();
    // multi is admin on Casa Alpha
    await expect(shell.adminNav).toBeVisible();
  });

  test("credenciais inválidas mostram erro e permanecem no login", async ({ page }) => {
    const login = new LoginPage(page);

    await login.goto();
    await login.login("admin@e2e.local", "senha-errada-xx");

    await expect(login.errorAlert).toContainText(/credenciais inválidas/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test("ModeToggle aplica tema escuro no html", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();

    await shell.setTheme("Escuro");
    await expect.poll(async () => shell.isDarkClass()).toBe(true);

    await shell.setTheme("Claro");
    await expect.poll(async () => shell.isDarkClass()).toBe(false);
  });

  test("navega Experts e Meu trabalho pelo menu", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await expect(page).toHaveURL("/");

    await shell.expertsNav.click();
    await expect(page).toHaveURL(/\/experts/);
    await expect(page.getByRole("heading", { name: /^experts$/i })).toBeVisible();

    await shell.meuTrabalhoNav.click();
    await expect(page).toHaveURL(/\/meu-trabalho/);
    await expect(page.getByRole("heading", { name: /meu trabalho/i })).toBeVisible();
  });
});
