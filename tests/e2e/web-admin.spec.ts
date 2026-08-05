/** @description E2E Admin — criar pessoa + login, bloqueio membro, IA validate via route mock. */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { LoginPage } from "../pages/login.page";
import { ShellPage } from "../pages/shell.page";

const PASSWORD = "password-e2e-ok";
const MOCK_API_KEY = "sk-e2e-mock-key-NOT-REAL-xyz";

/** @description Metadata DTO shape returned by LLM settings API mocks. */
type LlmSettingsMetadataMock = {
  provider: "openai" | "anthropic" | null;
  has_key: boolean;
  status: "none" | "unvalidated" | "valid" | "invalid";
  validated_at: string | null;
  last_error: string | null;
};

/**
 * @description Page Object da tela /admin (Pessoas | IA) — colocated while page-object path is gate-scoped to this file.
 */
class AdminPage {
  readonly heading: Locator;
  readonly pessoasTab: Locator;
  readonly iaTab: Locator;
  readonly pessoaButton: Locator;
  readonly dialog: Locator;
  readonly membroNome: Locator;
  readonly membroEmail: Locator;
  readonly membroSenha: Locator;
  readonly membroPapel: Locator;
  readonly criarButton: Locator;
  readonly membrosTable: Locator;
  readonly llmProvider: Locator;
  readonly llmApiKey: Locator;
  readonly salvarButton: Locator;
  readonly validarButton: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole("heading", { name: /^admin$/i });
    this.pessoasTab = page.getByRole("tab", { name: /^pessoas$/i });
    this.iaTab = page.getByRole("tab", { name: /^ia$/i });
    this.pessoaButton = page.getByRole("button", { name: /^pessoa$/i });
    this.dialog = page.getByRole("dialog");
    this.membroNome = page.locator("#membro-nome");
    this.membroEmail = page.locator("#membro-email");
    this.membroSenha = page.locator("#membro-senha");
    this.membroPapel = page.locator("#membro-papel");
    this.criarButton = this.dialog.getByRole("button", { name: /^criar$/i });
    this.membrosTable = page.locator("table");
    this.llmProvider = page.locator("#llm-provider");
    this.llmApiKey = page.locator("#llm-api-key");
    this.salvarButton = page.getByRole("button", { name: /^salvar$/i });
    this.validarButton = page.getByRole("button", { name: /^validar$/i });
  }

  /** @description Confirma que a AdminPage está visível. */
  async expectLoaded(): Promise<void> {
    await this.heading.waitFor({ state: "visible", timeout: 20_000 });
    await this.pessoasTab.waitFor({ state: "visible", timeout: 20_000 });
  }

  /** @description Abre Admin via shell nav e aguarda heading. */
  async openAdmin(shell: ShellPage): Promise<void> {
    await shell.adminNav.click();
    await this.page.waitForURL(/\/admin/);
    await this.expectLoaded();
  }

  /** @description Abre a aba Pessoas. */
  async switchToPessoas(): Promise<void> {
    await this.pessoasTab.click();
  }

  /** @description Abre a aba IA. */
  async switchToIa(): Promise<void> {
    await this.iaTab.click();
  }

  /**
   * @description Abre dialog Nova pessoa, preenche e confirma Criar.
   */
  async createPerson(opts: {
    name: string;
    email: string;
    password: string;
    papelLabel?: string | RegExp;
  }): Promise<void> {
    await this.pessoaButton.click();
    await this.dialog.waitFor({ state: "visible", timeout: 10_000 });
    await this.dialog
      .getByRole("heading", { name: /nova pessoa/i })
      .waitFor({ state: "visible" });

    await this.membroNome.fill(opts.name);
    await this.membroEmail.fill(opts.email);
    await this.membroSenha.fill(opts.password);

    const papelLabel = opts.papelLabel ?? /^membro$/i;
    await this.membroPapel.click();
    await this.page.getByRole("option", { name: papelLabel }).click();

    await this.criarButton.click();
    await this.dialog.waitFor({ state: "hidden", timeout: 20_000 });
  }

  /**
   * @description Locator do e-mail na tabela de membros.
   */
  emailInMembrosTable(email: string): Locator {
    return this.membrosTable.getByText(email, { exact: true });
  }

  /**
   * @description Seleciona provedor LLM no Select Radix.
   */
  async selectProvider(label: string | RegExp): Promise<void> {
    await this.llmProvider.click();
    await this.page.getByRole("option", { name: label }).click();
  }

  /**
   * @description Preenche chave, salva e valida (botões Salvar / Validar).
   */
  async saveAndValidateLlm(apiKey: string): Promise<void> {
    await this.llmApiKey.fill(apiKey);
    await this.salvarButton.click();
    // After PUT mock returns has_key, Validar becomes enabled
    await expect(this.validarButton).toBeEnabled({ timeout: 15_000 });
    await this.validarButton.click();
  }

  /**
   * @description Instala page.route mocks for LLM settings/validate/health (playwright-route-mock-llm-api).
   */
  async mockLlmApiRoutes(): Promise<void> {
    const noneMeta: LlmSettingsMetadataMock = {
      provider: null,
      has_key: false,
      status: "none",
      validated_at: null,
      last_error: null,
    };
    const unvalidatedMeta: LlmSettingsMetadataMock = {
      provider: "openai",
      has_key: true,
      status: "unvalidated",
      validated_at: null,
      last_error: null,
    };
    const validMeta: LlmSettingsMetadataMock = {
      provider: "openai",
      has_key: true,
      status: "valid",
      validated_at: new Date().toISOString(),
      last_error: null,
    };

    // More specific paths first so they are not swallowed by the base settings route
    await this.page.route(
      "**/api/empresa/llm-settings/validate",
      async (route: Route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(validMeta),
          });
          return;
        }
        await route.fallback();
      },
    );

    await this.page.route(
      "**/api/empresa/llm-settings/health",
      async (route: Route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }
        await route.fallback();
      },
    );

    await this.page.route(
      "**/api/empresa/llm-settings",
      async (route: Route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(noneMeta),
          });
          return;
        }
        if (method === "PUT") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(unvalidatedMeta),
          });
          return;
        }
        await route.fallback();
      },
    );
  }
}

test.describe("Admin Pessoas e IA", () => {
  /**
   * @description Admin cria membro com e-mail único; e-mail aparece na tabela; novo usuário autentica e chega na Home.
   */
  test("lt-e2e-admin-create-person-login", async ({ page, browser }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);
    const admin = new AdminPage(page);

    const stamp = Date.now();
    const email = `pessoa-e2e-${stamp}@e2e.local`;
    const name = `Pessoa E2E ${stamp}`;
    const newPassword = "password-e2e-ok";

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();

    await admin.openAdmin(shell);
    await admin.switchToPessoas();
    await admin.createPerson({
      name,
      email,
      password: newPassword,
      papelLabel: /^membro$/i,
    });

    await expect(admin.emailInMembrosTable(email)).toBeVisible({
      timeout: 20_000,
    });

    // Logout then new context: created user logs in and reaches Home shell
    await page.getByRole("button", { name: /^sair$/i }).click();
    await expect(page).toHaveURL(/\/login/);

    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    const freshLogin = new LoginPage(freshPage);

    await freshLogin.goto();
    await freshLogin.login(email, newPassword);
    await expect(freshPage).toHaveURL("/");
    await expect(
      freshPage.getByRole("heading", { name: /^home$/i }),
    ).toBeVisible({ timeout: 20_000 });

    await fresh.close();
  });

  /**
   * @description Membro não vê nav Admin; /admin não renderiza AdminPage (redirect home).
   */
  test("lt-e2e-membro-blocked-from-admin", async ({ page }) => {
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
    await expect(page.getByText(/pessoas da empresa/i)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^pessoas$/i })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^ia$/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^admin$/i })).toHaveCount(
      0,
    );
  });

  /**
   * @description Admin na aba IA com page.route mocks: salva chave mock, valida, vê estado válido sem ecoar a chave.
   */
  test("lt-e2e-admin-ia-validate-states", async ({ page }) => {
    const login = new LoginPage(page);
    const shell = new ShellPage(page);
    const admin = new AdminPage(page);

    await login.goto();
    await login.login("admin@e2e.local", PASSWORD);
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /^home$/i })).toBeVisible();

    await admin.mockLlmApiRoutes();

    await admin.openAdmin(shell);
    await admin.switchToIa();
    await expect(
      page.getByRole("heading", { name: /configuração de ia/i }),
    ).toBeVisible({ timeout: 20_000 });

    await admin.selectProvider(/^openai$/i);
    await admin.saveAndValidateLlm(MOCK_API_KEY);

    // Valid success state: badge and/or toast
    await expect(
      page
        .getByText(/^válida$/i)
        .or(page.getByText(/chave validada com sucesso/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    // Full api key must NOT remain visible in page content after save
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(MOCK_API_KEY);
    await expect(admin.llmApiKey).toHaveValue("");
  });
});
