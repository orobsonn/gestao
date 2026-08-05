/**
 * Locked AdminPage UI contracts — Pessoas|IA tabs only, create-membro body,
 * LLM status/health copy maps, /admin route wiring, LLM API path constants.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADMIN_TAB_IDS,
  buildCreateMembroBody,
  mapLlmHealthReasonCopy,
  mapLlmStatusBadge,
} from "../src/react-app/lib/admin-ui.ts";
import {
  LLM_HEALTH_API_PATH,
  LLM_SETTINGS_API_PATH,
  LLM_VALIDATE_API_PATH,
} from "../src/react-app/lib/domain-api.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_TSX = resolve(__dirname, "../src/react-app/App.tsx");

/**
 * @description ADMIN_TAB_IDS is exactly ['pessoas','ia'] and does not include telegram.
 */
test("lt-admin-tabs-pessoas-ia-only", () => {
  assert.ok(Array.isArray(ADMIN_TAB_IDS), "ADMIN_TAB_IDS must be an array");
  assert.deepEqual([...ADMIN_TAB_IDS], ["pessoas", "ia"]);
  assert.equal(
    ADMIN_TAB_IDS.includes("telegram"),
    false,
    "ADMIN_TAB_IDS must not include telegram",
  );
  assert.equal(ADMIN_TAB_IDS.length, 2);
});

/**
 * @description buildCreateMembroBody yields exactly name, email, password, papel; papel is admin|membro; no password hash field.
 */
test("lt-admin-create-membro-body", () => {
  const body = buildCreateMembroBody({
    name: "Ana Silva",
    email: "ana@example.com",
    password: "senha-secreta-123",
    papel: "membro",
  });

  assert.deepEqual(Object.keys(body).sort(), [
    "email",
    "name",
    "papel",
    "password",
  ]);
  assert.equal(body.name, "Ana Silva");
  assert.equal(body.email, "ana@example.com");
  assert.equal(body.password, "senha-secreta-123");
  assert.equal(body.papel, "membro");
  assert.ok(
    body.papel === "admin" || body.papel === "membro",
    "papel must be admin|membro",
  );
  assert.equal(
    Object.hasOwn(body, "password_hash"),
    false,
    "body must not carry a password hash field",
  );
  assert.equal(
    Object.hasOwn(body, "passwordHash"),
    false,
    "body must not carry a passwordHash field",
  );

  const adminBody = buildCreateMembroBody({
    name: "Admin",
    email: "admin@example.com",
    password: "senha-admin-456",
    papel: "admin",
  });
  assert.equal(adminBody.papel, "admin");
});

/**
 * @description mapLlmStatusBadge returns a distinct non-empty label for valid|invalid|unvalidated|none and never includes an api key.
 */
test("lt-admin-llm-status-badge-map", () => {
  const statuses = /** @type {const} */ ([
    "valid",
    "invalid",
    "unvalidated",
    "none",
  ]);
  /** @type {string[]} */
  const labels = [];

  for (const status of statuses) {
    const label = mapLlmStatusBadge(status);
    assert.equal(typeof label, "string", `label for ${status} must be a string`);
    assert.ok(label.trim().length > 0, `label for ${status} must be non-empty`);
    labels.push(label);
  }

  assert.equal(
    new Set(labels).size,
    statuses.length,
    "each Metadata status must map to a distinct Badge label",
  );

  const joined = labels.join(" ").toLowerCase();
  assert.equal(
    joined.includes("api_key"),
    false,
    "badge labels must not include api_key",
  );
  assert.equal(
    joined.includes("api key"),
    false,
    "badge labels must not include api key",
  );
  assert.equal(
    joined.includes("sk-"),
    false,
    "badge labels must not include key material prefixes",
  );
  assert.equal(
    joined.includes("ciphertext"),
    false,
    "badge labels must not include ciphertext",
  );
});

/**
 * @description mapLlmHealthReasonCopy yields clear non-empty user-visible messages for each health reason and embeds no secret material.
 */
test("lt-admin-llm-health-reason-copy", () => {
  const reasons = /** @type {const} */ ([
    "llm_key_unvalidated",
    "llm_key_invalid",
    "llm_not_configured",
    "llm_key_missing",
  ]);
  /** @type {string[]} */
  const messages = [];

  for (const reason of reasons) {
    const copy = mapLlmHealthReasonCopy(reason);
    assert.equal(
      typeof copy,
      "string",
      `copy for ${reason} must be a string`,
    );
    assert.ok(
      copy.trim().length > 0,
      `copy for ${reason} must be a non-empty product message`,
    );
    messages.push(copy);
  }

  assert.equal(
    new Set(messages).size,
    reasons.length,
    "each health reason must map to a distinct alert message",
  );

  const joined = messages.join(" ");
  assert.equal(
    joined.includes("sk-"),
    false,
    "health reason copy must not embed api key material",
  );
  assert.equal(
    joined.toLowerCase().includes("ciphertext"),
    false,
    "health reason copy must not embed ciphertext",
  );
  assert.equal(
    joined.toLowerCase().includes("api_key_iv"),
    false,
    "health reason copy must not embed iv material",
  );
});

/**
 * @description App.tsx /admin route renders AdminPage inside RequireEmpresaAdmin, not AdminPlaceholder.
 */
test("lt-admin-route-uses-admin-page", () => {
  const src = readFileSync(APP_TSX, "utf8");

  assert.match(
    src,
    /AdminPage/,
    "App.tsx must reference AdminPage",
  );
  assert.match(
    src,
    /from\s+["']\.\/pages\/AdminPage["']/,
    "App.tsx must import AdminPage from ./pages/AdminPage",
  );
  assert.match(
    src,
    /path=["']\/admin["']/,
    "App.tsx must declare the /admin route",
  );
  assert.match(
    src,
    /RequireEmpresaAdmin[\s\S]*?<AdminPage\s*\/>/,
    "/admin must render AdminPage inside RequireEmpresaAdmin",
  );
  assert.equal(
    /path=["']\/admin["'][\s\S]*?<AdminPlaceholder\s*\/>/.test(src),
    false,
    "/admin must not render AdminPlaceholder",
  );
});

/**
 * @description LLM settings SPA path constants match GET/PUT settings, POST validate, and GET health routes.
 */
test("lt-admin-llm-api-paths", () => {
  assert.equal(LLM_SETTINGS_API_PATH, "/api/empresa/llm-settings");
  assert.equal(
    LLM_VALIDATE_API_PATH,
    "/api/empresa/llm-settings/validate",
  );
  assert.equal(LLM_HEALTH_API_PATH, "/api/empresa/llm-settings/health");
});
