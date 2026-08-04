/** @description Page Object da tela /platform (super_admin). */

import type { Locator, Page } from "@playwright/test";

/**
 * @description Ações do formulário de criar empresa na plataforma.
 */
export class PlatformPage {
  readonly heading: Locator;
  readonly deniedHeading: Locator;
  readonly nomeInput: Locator;
  readonly adminNameInput: Locator;
  readonly adminEmailInput: Locator;
  readonly adminPasswordInput: Locator;
  readonly submitButton: Locator;
  readonly message: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole("heading", { name: /nova empresa/i });
    this.deniedHeading = page.getByRole("heading", { name: /acesso negado/i });
    this.nomeInput = page.locator('input[name="nome"]');
    this.adminNameInput = page.locator('input[name="admin.name"]');
    this.adminEmailInput = page.locator('input[name="admin.email"]');
    this.adminPasswordInput = page.locator('input[name="admin.password"]');
    this.submitButton = page.getByRole("button", { name: /criar empresa/i });
    this.message = page.locator("p.msg");
  }

  /** @description Abre /platform. */
  async goto(): Promise<void> {
    await this.page.goto("/platform");
  }

  /**
   * @description Preenche e envia o form de provisionamento.
   */
  async createEmpresa(opts: {
    nome: string;
    adminName: string;
    adminEmail: string;
    adminPassword: string;
  }): Promise<void> {
    await this.nomeInput.fill(opts.nome);
    await this.adminNameInput.fill(opts.adminName);
    await this.adminEmailInput.fill(opts.adminEmail);
    await this.adminPasswordInput.fill(opts.adminPassword);
    await this.submitButton.click();
  }
}
