/**
 * Locked Minha conta UI contracts — shell path, Telegram badge, mint path,
 * pending refetch policy, and sidebar entry.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUTH_TELEGRAM_LINK_PATH } from "../src/react-app/lib/auth-api.ts";
import {
  mapTelegramLinkBadge,
  shouldRefetchTelegramStatusOnFocus,
} from "../src/react-app/lib/minha-conta-ui.ts";
import {
  SHELL_AUTH_PATHS,
  isShellAuthPath,
} from "../src/react-app/lib/shell-routes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_TSX = resolve(__dirname, "../src/react-app/App.tsx");
const SESSION_GATE_TS = resolve(
  __dirname,
  "../src/react-app/lib/session-gate.ts",
);
const MINHA_CONTA_UI_TS = resolve(
  __dirname,
  "../src/react-app/lib/minha-conta-ui.ts",
);
const MINHA_CONTA_PAGE_TSX = resolve(
  __dirname,
  "../src/react-app/pages/MinhaContaPage.tsx",
);
const APP_SIDEBAR_TSX = resolve(
  __dirname,
  "../src/react-app/components/app-sidebar.tsx",
);

/**
 * @description isShellAuthPath('/minha-conta') is true; SHELL_AUTH_PATHS includes '/minha-conta'; App.tsx wires Route path /minha-conta to MinhaContaPage under RequireAuth.
 */
test("lt-ui-minha-conta-shell-path", () => {
  assert.equal(isShellAuthPath("/minha-conta"), true);
  assert.ok(
    Array.isArray(SHELL_AUTH_PATHS),
    "SHELL_AUTH_PATHS must be an array",
  );
  assert.ok(
    (SHELL_AUTH_PATHS).includes("/minha-conta"),
    "SHELL_AUTH_PATHS must include /minha-conta",
  );

  const src = readFileSync(APP_TSX, "utf8");
  assert.match(
    src,
    /MinhaContaPage/,
    "App.tsx must reference MinhaContaPage",
  );
  assert.match(
    src,
    /from\s+["']\.\/pages\/MinhaContaPage["']/,
    "App.tsx must import MinhaContaPage from ./pages/MinhaContaPage",
  );
  assert.match(
    src,
    /path=["']\/minha-conta["']/,
    "App.tsx must declare the /minha-conta route",
  );
  assert.match(
    src,
    /RequireAuth[\s\S]*?path=["']\/minha-conta["'][\s\S]*?<MinhaContaPage\s*\/>/,
    "/minha-conta must render MinhaContaPage under RequireAuth shell",
  );
});

/**
 * @description mapTelegramLinkBadge(true) is 'vinculado' and mapTelegramLinkBadge(false) is 'pendente'; Me requires telegram.linked boolean; helpers never expose telegram_user_id.
 */
test("lt-ui-badge-from-linked", () => {
  assert.equal(mapTelegramLinkBadge(true), "vinculado");
  assert.equal(mapTelegramLinkBadge(false), "pendente");

  const meSrc = readFileSync(SESSION_GATE_TS, "utf8");
  assert.match(
    meSrc,
    /telegram\s*:\s*\{\s*linked\s*:\s*boolean\s*\}/,
    "Me type must require telegram:{linked:boolean}",
  );
  assert.equal(
    meSrc.includes("telegram_user_id"),
    false,
    "Me type must not expose telegram_user_id",
  );

  const helpersSrc = readFileSync(MINHA_CONTA_UI_TS, "utf8");
  assert.equal(
    helpersSrc.includes("telegram_user_id"),
    false,
    "minha-conta-ui helpers must not expose telegram_user_id",
  );

  const badgeJoined = [mapTelegramLinkBadge(true), mapTelegramLinkBadge(false)]
    .join(" ");
  assert.equal(
    badgeJoined.includes("telegram_user_id"),
    false,
    "badge labels must not expose telegram_user_id",
  );
});

/**
 * @description AUTH_TELEGRAM_LINK_PATH is '/api/auth/telegram-link'; Vincular opens mint deep_link with target _blank; Atualizar status invokes refreshMe.
 */
test("lt-ui-mint-path-and-vincular-contract", () => {
  assert.equal(AUTH_TELEGRAM_LINK_PATH, "/api/auth/telegram-link");

  const pageSrc = readFileSync(MINHA_CONTA_PAGE_TSX, "utf8");
  assert.match(
    pageSrc,
    /Vincular Telegram/,
    "MinhaContaPage must label the primary action Vincular Telegram",
  );
  assert.match(
    pageSrc,
    /deep_link/,
    "MinhaContaPage must use mint response deep_link",
  );
  assert.match(
    pageSrc,
    /_blank/,
    "Vincular must open deep_link with target _blank",
  );
  assert.match(
    pageSrc,
    /window\.open|open\s*\(/,
    "Vincular must open the deep_link in a new browsing context",
  );
  assert.match(
    pageSrc,
    /Atualizar status/,
    "MinhaContaPage must label the refresh action Atualizar status",
  );
  assert.match(
    pageSrc,
    /refreshMe/,
    "Atualizar status must invoke refreshMe",
  );
});

/**
 * @description shouldRefetchTelegramStatusOnFocus is true when linked is false and false when linked is true; MinhaContaPage registers focus and visibilitychange while pendente.
 */
test("lt-ui-pending-refetch-policy", () => {
  assert.equal(shouldRefetchTelegramStatusOnFocus(false), true);
  assert.equal(shouldRefetchTelegramStatusOnFocus(true), false);

  const pageSrc = readFileSync(MINHA_CONTA_PAGE_TSX, "utf8");
  assert.match(
    pageSrc,
    /addEventListener\s*\(\s*["']focus["']/,
    "MinhaContaPage must register a focus listener while pendente",
  );
  assert.match(
    pageSrc,
    /addEventListener\s*\(\s*["']visibilitychange["']/,
    "MinhaContaPage must register a visibilitychange listener while pendente",
  );
  assert.match(
    pageSrc,
    /shouldRefetchTelegramStatusOnFocus|linked\s*===?\s*false|!.*linked/,
    "MinhaContaPage must gate refetch on pending (linked===false) status",
  );
});

/**
 * @description app-sidebar.tsx has a Minha conta navigation entry targeting /minha-conta in the user footer dropdown area (not Admin tabs).
 */
test("lt-ui-sidebar-minha-conta", () => {
  const src = readFileSync(APP_SIDEBAR_TSX, "utf8");

  assert.match(
    src,
    /Minha conta/,
    "app-sidebar must contain a Minha conta entry",
  );
  assert.match(
    src,
    /\/minha-conta/,
    "app-sidebar Minha conta entry must target /minha-conta",
  );
  assert.match(
    src,
    /SidebarFooter[\s\S]*Minha conta[\s\S]*\/minha-conta|SidebarFooter[\s\S]*\/minha-conta[\s\S]*Minha conta/,
    "Minha conta must live in the user footer area",
  );
  assert.equal(
    /ADMIN_TAB|AdminTab|tabs.*telegram/i.test(src),
    false,
    "Minha conta must not be wired as an Admin tab",
  );
});
