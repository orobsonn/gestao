/** @description E2E das jornadas Experts → Campanha → Tarefa (CRUD, papel, filtros, breadcrumb). */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import { ShellPage } from "../pages/shell.page";

const PASSWORD = "password-e2e-ok";
/** @description Expert estável do seed e2e (scripts/e2e-seed.mjs). */
const SEED_EXPERT = "Expert E2E Alpha";
/** @description Campanha estável do seed e2e. */
const SEED_CAMPANHA = "Campanha E2E Alpha";

/**
 * @description Locators scoped to domain pages (Experts / Campanha / Tarefa).
 */
function domainLocators(page: Page) {
  const main = page.locator("main").last();
  const expertsHeading = page.getByRole("heading", { name: /^experts$/i });
  const createExpertButton = main.getByRole("button", { name: /^expert$/i });
  const createCampanhaButton = main.getByRole("button", {
    name: /^campanha$/i,
  });
  const createTarefaButton = main.getByRole("button", { name: /^tarefa$/i });
  const breadcrumb = page.locator('nav[aria-label="breadcrumb"]');
  const statusFilter = page.locator("#status");
  const donoFilter = page.locator("#dono");
  const campanhaFilter = page.locator(
    "#campanha, [data-testid='campanha'], [id*='filter-campanha']",
  );
  const tarefaDetailTitulo = page.locator("#tarefa-detail-titulo");
  const tarefaDetailDono = page.locator("#tarefa-detail-dono");
  const tarefaDetailPrazo = page.locator("#tarefa-detail-prazo");
  const tarefaDetailStatus = page.locator("#tarefa-detail-status");
  const tarefaDetailNotas = page.locator("#tarefa-detail-notas");
  const salvarButton = page.getByRole("button", { name: /^salvar$/i });
  const excluirButton = page.getByRole("button", { name: /^excluir$/i });
  const dialog = page.getByRole("dialog");
  const alertdialog = page.getByRole("alertdialog");

  /**
   * @description Linha de tabela com role=link contendo o texto.
   */
  function rowByText(text: string): Locator {
    return main.locator('tr[role="link"]', { hasText: text });
  }

  return {
    main,
    expertsHeading,
    createExpertButton,
    createCampanhaButton,
    createTarefaButton,
    breadcrumb,
    statusFilter,
    donoFilter,
    campanhaFilter,
    tarefaDetailTitulo,
    tarefaDetailDono,
    tarefaDetailPrazo,
    tarefaDetailStatus,
    tarefaDetailNotas,
    salvarButton,
    excluirButton,
    dialog,
    alertdialog,
    rowByText,
  };
}

type DomainLoc = ReturnType<typeof domainLocators>;

/**
 * @description Aguarda a lista de Experts carregar.
 */
async function waitForExpertsLoaded(page: Page, loc: DomainLoc): Promise<void> {
  await page.waitForURL(/\/experts\/?$/);
  await expect(loc.expertsHeading).toBeVisible({ timeout: 20_000 });
  await loc.main
    .locator("table")
    .or(loc.main.getByText(/nenhum expert/i))
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * @description Login admin e navega até /experts com lista pronta.
 */
async function loginAdminAndOpenExperts(
  page: Page,
): Promise<{ shell: ShellPage; loc: DomainLoc }> {
  const login = new LoginPage(page);
  const shell = new ShellPage(page);
  const loc = domainLocators(page);

  await login.goto();
  await login.login("admin@e2e.local", PASSWORD);
  await expect(page).toHaveURL("/");
  await shell.expertsNav.click();
  await waitForExpertsLoaded(page, loc);
  return { shell, loc };
}

/**
 * @description Login membro e navega até /experts com lista pronta.
 */
async function loginMembroAndOpenExperts(
  page: Page,
): Promise<{ shell: ShellPage; loc: DomainLoc }> {
  const login = new LoginPage(page);
  const shell = new ShellPage(page);
  const loc = domainLocators(page);

  await login.goto();
  await login.login("membro@e2e.local", PASSWORD);
  await expect(page).toHaveURL("/");
  await shell.expertsNav.click();
  await waitForExpertsLoaded(page, loc);
  return { shell, loc };
}

/**
 * @description YYYY-MM-DD em UTC com offset de dias (prazo de formulário date).
 */
function ymdUtc(offsetDays = 0): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * @description Seleciona opção em um Select Radix pelo trigger locator.
 */
async function selectOption(
  page: Page,
  trigger: Locator,
  optionLabel: string | RegExp,
): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: optionLabel }).click();
}

/**
 * @description Abre dialog + Expert, preenche nome e confirma Criar.
 */
async function createExpert(
  page: Page,
  loc: DomainLoc,
  nome: string,
): Promise<void> {
  await loc.createExpertButton.click();
  await expect(loc.dialog).toBeVisible();
  await page.locator("#expert-nome").fill(nome);
  await loc.dialog.getByRole("button", { name: /^criar$/i }).click();
  await expect(loc.dialog).toBeHidden({ timeout: 20_000 });
  await expect(loc.rowByText(nome)).toBeVisible({ timeout: 20_000 });
}

/**
 * @description Abre dialog + Campanha, preenche nome e confirma Criar.
 */
async function createCampanha(
  page: Page,
  loc: DomainLoc,
  nome: string,
): Promise<void> {
  await loc.createCampanhaButton.click();
  await expect(loc.dialog).toBeVisible();
  await page.locator("#campanha-nome").fill(nome);
  await loc.dialog.getByRole("button", { name: /^criar$/i }).click();
  await expect(loc.dialog).toBeHidden({ timeout: 20_000 });
  await expect(loc.rowByText(nome)).toBeVisible({ timeout: 20_000 });
}

/**
 * @description Abre dialog + Tarefa, preenche título e confirma Criar.
 */
async function createTarefa(
  page: Page,
  loc: DomainLoc,
  titulo: string,
): Promise<void> {
  await loc.createTarefaButton.click();
  await expect(loc.dialog).toBeVisible();
  await page.locator("#tarefa-titulo").fill(titulo);
  await loc.dialog.getByRole("button", { name: /^criar$/i }).click();
  await expect(loc.dialog).toBeHidden({ timeout: 20_000 });
  await expect(loc.rowByText(titulo)).toBeVisible({ timeout: 20_000 });
}

/**
 * @description Preenche o formulário de detalhe da tarefa e salva.
 */
async function fillAndSaveTarefa(
  page: Page,
  loc: DomainLoc,
  fields: {
    titulo: string;
    statusLabel: string | RegExp;
    donoLabel?: string | RegExp;
    prazo?: string;
    notas: string;
  },
): Promise<void> {
  await loc.tarefaDetailTitulo.fill(fields.titulo);
  if (fields.donoLabel) {
    await selectOption(page, loc.tarefaDetailDono, fields.donoLabel);
  }
  if (fields.prazo) {
    await loc.tarefaDetailPrazo.fill(fields.prazo);
  }
  await selectOption(page, loc.tarefaDetailStatus, fields.statusLabel);
  await loc.tarefaDetailNotas.fill(fields.notas);
  await loc.salvarButton.click();
  await page
    .getByText(/tarefa salva/i)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {
      /* toast may dismiss quickly — form values still assert persistence */
    });
}

/**
 * @description Clica Excluir; retorna true se dialog/alertdialog de confirmação aparecer.
 */
async function excluirAndDialogAppeared(
  page: Page,
  loc: DomainLoc,
  timeoutMs = 800,
): Promise<boolean> {
  await loc.excluirButton.click();
  const appeared = await Promise.race([
    loc.dialog
      .or(loc.alertdialog)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false),
    page
      .waitForURL(/\/experts\/[^/]+\/campanhas\/[^/]+/, { timeout: 20_000 })
      .then(() => false)
      .catch(() => false),
  ]);
  return appeared;
}

test.describe("Domínio Experts / Campanha / Tarefa", () => {
  /**
   * @description Admin cria expert → campanha → tarefa, edita e salva, exclui sem dialog e some da lista.
   */
  test("lt-e2e-admin-expert-campanha-task-crud", async ({ page }) => {
    const stamp = Date.now();
    const expertNome = `E2E Expert ${stamp}`;
    const campanhaNome = `E2E Campanha ${stamp}`;
    const tarefaTitulo = `E2E Tarefa ${stamp}`;
    const editedTitulo = `E2E Tarefa editada ${stamp}`;
    const editedNotas = `notas e2e ${stamp} https://example.com/x`;
    const editedPrazo = ymdUtc(3);

    const { loc } = await loginAdminAndOpenExperts(page);

    await createExpert(page, loc, expertNome);
    await loc.rowByText(expertNome).click();
    await expect(page).toHaveURL(/\/experts\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: expertNome }),
    ).toBeVisible({ timeout: 20_000 });

    await createCampanha(page, loc, campanhaNome);
    await loc.rowByText(campanhaNome).click();
    await expect(page).toHaveURL(/\/experts\/[^/]+\/campanhas\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: campanhaNome }),
    ).toBeVisible({ timeout: 20_000 });

    await createTarefa(page, loc, tarefaTitulo);
    await loc.rowByText(tarefaTitulo).click();
    await expect(page).toHaveURL(/\/tarefas\/[^/]+$/);
    await expect(loc.tarefaDetailTitulo).toBeVisible({ timeout: 20_000 });
    await expect(loc.tarefaDetailTitulo).toHaveValue(tarefaTitulo);

    await fillAndSaveTarefa(page, loc, {
      titulo: editedTitulo,
      statusLabel: /^fazendo$/i,
      donoLabel: /admin e2e/i,
      prazo: editedPrazo,
      notas: editedNotas,
    });

    // Persistência: recarrega o detalhe e confere campos
    await page.reload();
    await expect(loc.tarefaDetailTitulo).toBeVisible({ timeout: 20_000 });
    await expect(loc.tarefaDetailTitulo).toHaveValue(editedTitulo);
    await expect(loc.tarefaDetailPrazo).toHaveValue(editedPrazo);
    await expect(loc.tarefaDetailNotas).toHaveValue(editedNotas);
    await expect(loc.tarefaDetailStatus).toContainText(/fazendo/i);
    await expect(loc.tarefaDetailDono).toContainText(/admin e2e/i);

    const dialogAppeared = await excluirAndDialogAppeared(page, loc);
    expect(dialogAppeared).toBe(false);

    await expect(page).toHaveURL(/\/experts\/[^/]+\/campanhas\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: campanhaNome }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(loc.rowByText(editedTitulo)).toHaveCount(0);
    await expect(loc.rowByText(tarefaTitulo)).toHaveCount(0);
  });

  /**
   * @description Membro não vê + Expert/+ Campanha; ainda pode criar tarefa na campanha.
   */
  test("lt-e2e-member-no-admin-creates", async ({ page }) => {
    const stamp = Date.now();
    const tarefaTitulo = `E2E Membro tarefa ${stamp}`;

    const { loc } = await loginMembroAndOpenExperts(page);

    await expect(loc.createExpertButton).toHaveCount(0);

    await loc.rowByText(SEED_EXPERT).click();
    await expect(page).toHaveURL(/\/experts\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: SEED_EXPERT }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(loc.createCampanhaButton).toHaveCount(0);

    await loc.rowByText(SEED_CAMPANHA).click();
    await expect(page).toHaveURL(/\/experts\/[^/]+\/campanhas\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: SEED_CAMPANHA }),
    ).toBeVisible({ timeout: 20_000 });

    await expect(loc.createTarefaButton).toBeVisible();
    await createTarefa(page, loc, tarefaTitulo);
    await expect(loc.rowByText(tarefaTitulo)).toBeVisible();
  });

  /**
   * @description Campanha só tem filtros status+dono; breadcrumb hierárquico com Experts.
   */
  test("lt-e2e-campaign-filters-and-breadcrumb", async ({ page }) => {
    const { loc } = await loginAdminAndOpenExperts(page);

    await loc.rowByText(SEED_EXPERT).click();
    await expect(page).toHaveURL(/\/experts\/[^/]+$/);
    await loc.rowByText(SEED_CAMPANHA).click();
    await expect(page).toHaveURL(/\/experts\/[^/]+\/campanhas\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: SEED_CAMPANHA }),
    ).toBeVisible({ timeout: 20_000 });

    await expect(loc.statusFilter).toBeVisible();
    await expect(loc.donoFilter).toBeVisible();
    await expect(loc.campanhaFilter).toHaveCount(0);
    await expect(
      loc.main
        .getByLabel(/^campanha$/i)
        .or(loc.main.locator('[data-testid*="campanha"]')),
    ).toHaveCount(0);

    const crumb = loc.breadcrumb;
    await expect(crumb).toBeVisible();
    // shadcn separators are ChevronRight SVGs (not "/" or ">") — assert via DOM items
    await expect(
      crumb
        .getByRole("link", { name: /^Experts$/i })
        .or(crumb.getByText(/^Experts$/i)),
    ).toBeVisible();
    const items = crumb.locator('li:not([role="presentation"])');
    expect(await items.count()).toBeGreaterThanOrEqual(2);
    const crumbText = (await crumb.innerText()).replace(/\s+/g, " ").trim();
    expect(crumbText).not.toMatch(/^gestão$/i);
  });

  /**
   * @description Lista de Experts mostra contagens numéricas; clique navega para /experts/:id.
   */
  test("lt-e2e-experts-list-counts-navigate", async ({ page }) => {
    const { loc } = await loginAdminAndOpenExperts(page);

    const row = loc.rowByText(SEED_EXPERT);
    await expect(row).toBeVisible({ timeout: 20_000 });

    const numericBadges = row.getByText(/^\d+$/);
    await expect(numericBadges.first()).toBeVisible();
    const countTexts = await numericBadges.allTextContents();
    const numbers = countTexts
      .map((t) => t.trim())
      .filter((t) => /^\d+$/.test(t))
      .map(Number);
    expect(numbers.length).toBeGreaterThanOrEqual(2);
    // Seed has open + late tasks on Expert E2E Alpha
    expect(numbers.some((n) => n >= 1)).toBe(true);

    await row.click();
    await expect(page).toHaveURL(/\/experts\/[^/]+$/);
    const expertId = page.url().match(/\/experts\/([^/?#]+)/)?.[1];
    expect(expertId).toBeTruthy();
    expect(expertId).not.toBe("");
    await expect(
      page.getByRole("heading", { name: SEED_EXPERT }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
