/** @description Page Object da tela /admin (Pessoas | IA). */

import { expect, type Locator, type Page, type Route } from "@playwright/test";
import type { ShellPage } from "./shell.page";

/** @description Metadata DTO shape returned by LLM settings API mocks. */
type LlmSettingsMetadataMock = {
  provider: "openai" | "anthropic" | null;
  has_key: boolean;
  status: "none" | "unvalidated" | "valid" | "invalid";
  validated_at: string | null;
  last_error: string | null;
};

/**
 * @description Encapsula seletores e ações da página /admin (abas Pessoas | IA).
 */
export class AdminPage {
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
