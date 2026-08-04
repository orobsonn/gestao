/** @description Page Object da tela de login. */

import type { Locator, Page } from "@playwright/test";

/**
 * @description Encapsula seletores e ações da página /login.
 */
export class LoginPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorAlert: Locator;

  constructor(private readonly page: Page) {
    this.emailInput = page.getByLabel(/e-mail/i);
    this.passwordInput = page.getByLabel(/^senha$/i);
    this.submitButton = page.getByRole("button", { name: /^entrar$/i });
    this.errorAlert = page.getByRole("alert");
  }

  /** @description Navega para /login. */
  async goto(): Promise<void> {
    await this.page.goto("/login");
  }

  /**
   * @description Preenche e envia o formulário de login.
   */
  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
