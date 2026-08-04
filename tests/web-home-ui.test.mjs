/**
 * Locked HomePage UI paths, heading, KPI theme tokens, and tarefa detail stub contracts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOME_API_PATH,
  HOME_KPI_THEME_CLASSES,
  HOME_PAGE_HEADING,
} from "../src/react-app/lib/home-api.ts";
import {
  buildTarefaDetailPath,
  TAREFA_DETAIL_BACK_HREF,
  TAREFA_DETAIL_STUB_MESSAGE,
} from "../src/react-app/lib/shell-routes.ts";

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}/;
const THEME_SEMANTIC_NEEDLES = [
  "bg-card",
  "text-muted-foreground",
  "text-destructive",
  "border-border",
];

/**
 * @description Collect every string className token from a nested class map / style tokens export.
 * @param {unknown} value
 * @param {string[]} out
 */
function collectClassStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectClassStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectClassStrings(item, out);
  }
  return out;
}

/**
 * @description buildTarefaDetailPath('abc-123') returns exactly '/tarefas/abc-123'.
 */
test("lt-tarefa-detail-path", () => {
  assert.equal(buildTarefaDetailPath("abc-123"), "/tarefas/abc-123");
});

/**
 * @description HOME_API_PATH is '/api/empresa/home' and HOME_PAGE_HEADING is exactly 'Home'.
 */
test("lt-home-api-path-and-heading", () => {
  assert.equal(HOME_API_PATH, "/api/empresa/home");
  assert.equal(HOME_PAGE_HEADING, "Home");
});

/**
 * @description KPI/badge theme class tokens use semantic utilities and contain no raw hex colors.
 */
test("lt-kpi-theme-tokens-no-hex", () => {
  const classStrings = collectClassStrings(HOME_KPI_THEME_CLASSES);
  assert.ok(
    classStrings.length > 0,
    "HOME_KPI_THEME_CLASSES must export at least one className string",
  );

  const joined = classStrings.join(" ");
  for (const needle of THEME_SEMANTIC_NEEDLES) {
    assert.ok(
      joined.includes(needle),
      `KPI/badge theme tokens must include semantic utility "${needle}"`,
    );
  }

  for (const className of classStrings) {
    assert.equal(
      HEX_COLOR_RE.test(className),
      false,
      `className must not contain raw hex color literals: ${className}`,
    );
  }
});

/**
 * @description Tarefa detail stub message is 'Detalhe da tarefa — em breve' and back link target is '/'.
 */
test("lt-stub-copy-constant", () => {
  assert.equal(TAREFA_DETAIL_STUB_MESSAGE, "Detalhe da tarefa — em breve");
  assert.equal(TAREFA_DETAIL_BACK_HREF, "/");
});
