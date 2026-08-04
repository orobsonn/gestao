/** @description Page Object do casco autenticado (sidebar, tema, picker). */

import type { Locator, Page } from "@playwright/test";

/**
 * @description Ações do usuário no shell pós-login.
 */
export class ShellPage {
  readonly homeNav: Locator;
  readonly expertsNav: Locator;
  readonly meuTrabalhoNav: Locator;
  readonly adminNav: Locator;
  readonly themeToggle: Locator;
  readonly pickerTitle: Locator;

  constructor(private readonly page: Page) {
    // Scope to sidebar so breadcrumb current-page link does not collide
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    this.homeNav = sidebar.getByRole("link", { name: /^home$/i });
    this.expertsNav = sidebar.getByRole("link", { name: /^experts$/i });
    this.meuTrabalhoNav = sidebar.getByRole("link", { name: /meu trabalho/i });
    this.adminNav = sidebar.getByRole("link", { name: /^admin$/i });
    this.themeToggle = page.getByRole("button", { name: /alternar tema/i });
    this.pickerTitle = page.getByRole("heading", { name: /escolha a empresa/i });
  }

  /** @description Clica na empresa do picker bloqueante. */
  async chooseEmpresa(nome: string): Promise<void> {
    await this.page.getByRole("button", { name: new RegExp(nome, "i") }).click();
  }

  /** @description Define tema via ModeToggle. */
  async setTheme(label: "Claro" | "Escuro" | "Sistema"): Promise<void> {
    await this.themeToggle.click();
    await this.page.getByRole("menuitem", { name: label }).click();
  }

  /** @description True se o html tem classe dark. */
  async isDarkClass(): Promise<boolean> {
    return this.page.locator("html").evaluate((el) => el.classList.contains("dark"));
  }
}
