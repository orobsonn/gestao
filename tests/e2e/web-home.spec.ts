/** @description E2E da Home dashboard — KPIs, lens admin/membro, detalhe live de tarefa e tema. */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import { ShellPage } from "../pages/shell.page";

const PASSWORD = "password-e2e-ok";

/**
 * @description Locators scoped to the shell main content for the Home dashboard.
 */
function homeLocators(page: Page) {
  const main = page.locator("main").last();
  const heading = page.getByRole("heading", { name: /^home$/i });
  const lensGroup = page.getByRole("radiogroup", { name: /filtro da home/i });
  const lensTudo = lensGroup.getByRole("radio", { name: /^tudo$/i });
  const lensSoMeu = lensGroup.getByRole("radio", { name: /^só meu$/i });
  const lensSoEmpresa = lensGroup.getByRole("radio", {
    name: /^só empresa$/i,
  });
  const meuTrabalhoSection = main.getByRole("heading", {
    name: /^meu trabalho$/i,
  });
  const empresaSection = main.getByRole("heading", { name: /^empresa$/i });
  const chartUrgencia = main.getByRole("heading", { name: /^urgência$/i });
  const chartStatus = main.getByRole("heading", { name: /^status$/i });
  // KPI labels are CardDescription <p> — avoid SVG chart tick collisions
  const kpiAtrasadas = main.locator("p", { hasText: /^Atrasadas$/ });
  const kpiHoje = main.locator("p", { hasText: /^Hoje$/ });
  const kpiMinhas = main.locator("p", { hasText: /^Minhas$/ });
  const kpiAbertas = main.locator("p", { hasText: /^Abertas$/ });
  const kpiFeitas = main.locator("p", { hasText: /^Feitas 7d$/ });
  const firstTaskRow = main.locator('tr[role="link"]').first();

  return {
    main,
    heading,
    lensGroup,
    lensTudo,
    lensSoMeu,
    lensSoEmpresa,
    meuTrabalhoSection,
    empresaSection,
    chartUrgencia,
    chartStatus,
    kpiAtrasadas,
    kpiHoje,
    kpiMinhas,
    kpiAbertas,
    kpiFeitas,
    firstTaskRow,
  };
}

/**
 * @description Aguarda o corpo da Home carregar após login (KPI ou lista).
 */
async function waitForHomeLoaded(
  page: Page,
  loc: ReturnType<typeof homeLocators>,
): Promise<void> {
  await expect(page).toHaveURL("/");
  await expect(loc.heading).toBeVisible();
  await loc.kpiAtrasadas
    .or(loc.meuTrabalhoSection)
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * @description Clica uma lente do toggle admin.
 */
async function selectLens(
  loc: ReturnType<typeof homeLocators>,
  label: "Tudo" | "Só meu" | "Só empresa",
): Promise<void> {
  const map: Record<string, Locator> = {
    Tudo: loc.lensTudo,
    "Só meu": loc.lensSoMeu,
    "Só empresa": loc.lensSoEmpresa,
  };
  await map[label].click();
}

test.describe("Home dashboard", () => {
  /**
   * @description Admin sob Tudo vê KPIs + Meu trabalho + Empresa; Só meu esconde Empresa/charts; Só empresa esconde Meu trabalho.
   */
  test("lt-e2e-admin-tudo-kpis-lists-toggle", async ({ page }) => {
    const login = new LoginPage(page);
    const home = homeLocators(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await waitForHomeLoaded(page, home);

    await expect(home.heading).toBeVisible();

    // At least four KPI labels under default Tudo (Atrasadas/Hoje/Minhas or Abertas/Feitas)
    await expect(home.kpiAtrasadas).toBeVisible();
    await expect(home.kpiHoje).toBeVisible();
    await expect(home.kpiMinhas.or(home.kpiAbertas).first()).toBeVisible();
    await expect(home.kpiFeitas).toBeVisible();

    await expect(home.meuTrabalhoSection).toBeVisible();
    await expect(home.empresaSection).toBeVisible();
    await expect(home.lensGroup).toBeVisible();
    await expect(home.chartUrgencia).toBeVisible();
    await expect(home.chartStatus).toBeVisible();

    // Só meu: hides Empresa section and charts
    await selectLens(home, "Só meu");
    await expect(home.meuTrabalhoSection).toBeVisible();
    await expect(home.empresaSection).toHaveCount(0);
    await expect(home.chartUrgencia).toHaveCount(0);
    await expect(home.chartStatus).toHaveCount(0);

    // Só empresa: hides Meu trabalho
    await selectLens(home, "Só empresa");
    await expect(home.empresaSection).toBeVisible();
    await expect(home.meuTrabalhoSection).toHaveCount(0);
  });

  /**
   * @description Membro vê Home pessoal sem toggle e sem seção Empresa.
   */
  test("lt-e2e-membro-personal-only", async ({ page }) => {
    const login = new LoginPage(page);
    const home = homeLocators(page);

    await login.goto();
    await login.login("membro@e2e.local", PASSWORD);
    await waitForHomeLoaded(page, home);

    await expect(home.heading).toBeVisible();
    await expect(home.lensGroup).toHaveCount(0);
    await expect(home.empresaSection).toHaveCount(0);

    await expect(home.kpiAtrasadas).toBeVisible();
    await expect(home.kpiHoje).toBeVisible();
    await expect(home.kpiMinhas).toBeVisible();
    await expect(home.kpiFeitas).toBeVisible();
    await expect(home.meuTrabalhoSection).toBeVisible();
  });

  /**
   * @description Clique em linha de tarefa abre TarefaDetailPage live; Voltar vai à campanha.
   */
  test("lt-e2e-home-task-row-opens-detail", async ({ page }) => {
    const login = new LoginPage(page);
    const home = homeLocators(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await waitForHomeLoaded(page, home);

    await expect(home.firstTaskRow).toBeVisible({ timeout: 20_000 });
    await home.firstTaskRow.click();

    await expect(page).toHaveURL(/\/tarefas\/[^/]+$/);

    await expect(
      page.getByText(/detalhe da tarefa — em breve/i),
    ).toHaveCount(0);

    const liveForm = page
      .getByRole("heading", { name: /^tarefa$/i })
      .or(page.getByRole("button", { name: /^salvar$/i }))
      .or(page.locator("#tarefa-detail-titulo"));
    await expect(liveForm.first()).toBeVisible({ timeout: 20_000 });

    await expect(
      page.getByRole("link", { name: /voltar para home/i }),
    ).toHaveCount(0);

    const voltar = page.getByRole("button", { name: /^voltar$/i });
    await expect(voltar).toBeVisible();
    await voltar.click();
    await expect(page).toHaveURL(/\/experts\/[^/]+\/campanhas\/[^/]+$/);
  });

  /**
   * @description Em tema Escuro, labels de KPI permanecem visíveis (tokens legíveis).
   */
  test("lt-e2e-dark-mode-kpi-labels", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);
    const home = homeLocators(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await waitForHomeLoaded(page, home);

    await shell.setTheme("Escuro");
    await expect.poll(async () => shell.isDarkClass()).toBe(true);

    const kpiLabel = home.kpiAtrasadas.or(home.kpiFeitas).first();
    await expect(kpiLabel).toBeVisible();
    await expect(kpiLabel).not.toBeEmpty();
  });
});
