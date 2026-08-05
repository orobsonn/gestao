/**
 * Locked empresa LLM settings contract — metadata GET/PUT, validate, health, authz, isolation.
 * Hermetic: node:sqlite + Hono app.request via createEmpresaApp(db, deps).
 * openDb applies every migrations/*.sql sorted with PRAGMA foreign_keys=ON.
 * Injects llmProbe; never hits real vendor networks.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/worker/auth/password.ts";
import {
  buildSessionCookie,
  mintSession,
} from "../src/worker/auth/session.ts";
import { createEmpresaApp } from "../src/worker/routes/empresa.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const SESSION_COOKIE_NAME = "gestao_session";
const LLM_SETTINGS_PATH = "/api/empresa/llm-settings";
const LLM_VALIDATE_PATH = "/api/empresa/llm-settings/validate";
const LLM_HEALTH_PATH = "/api/empresa/llm-settings/health";
const TAREFAS_PATH = "/api/empresa/tarefas";

const TEST_ENCRYPTION_SECRET = "test-llm-key-encryption-secret-hermetic";
const PLAINTEXT_KEY = "sk-test-secret-value-xyz";
const TENANT_A_KEY = "sk-tenant-a-secret";

/**
 * @description Open in-memory SQLite, enable FKs, apply every migrations/*.sql sorted by filename.
 * @returns {DatabaseSync}
 */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
    db.exec(sql);
  }
  return db;
}

/**
 * @description Seed a role=user with known password via hashPassword.
 * @param {DatabaseSync} db
 * @param {{ id?: string, email?: string, name?: string, password?: string }} [opts]
 */
async function seedUser(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const email = opts.email ?? "user@example.com";
  const name = opts.name ?? "Regular User";
  const password = opts.password ?? "secure-pass-ok";
  assert.ok(password.length >= 8);

  const { hash, salt } = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(id, email, name, hash, salt);

  return { id, email, name, password, role: "user", hash, salt };
}

/**
 * @description Seed an empresa row (active — deleted_at NULL).
 * @param {DatabaseSync} db
 * @param {{ id?: string, nome?: string }} [opts]
 */
function seedEmpresa(db, opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Empresa Seed";
  db.prepare(`INSERT INTO empresas (id, nome) VALUES (?, ?)`).run(id, nome);
  return { id, nome };
}

/**
 * @description Seed empresa_membros link.
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, userId: string, papel?: string, id?: string }} opts
 */
function seedMembership(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const papel = opts.papel ?? "admin";
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, ?)`,
  ).run(id, opts.empresaId, opts.userId, papel);
  return { id, papel };
}

/**
 * @description Seed a live expert row (deleted_at NULL).
 * @param {DatabaseSync} db
 * @param {{ empresaId: string, id?: string, nome?: string }} opts
 */
function seedExpert(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Expert Seed";
  db.prepare(
    `INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, ?)`,
  ).run(id, opts.empresaId, nome);
  return { id, nome, empresaId: opts.empresaId };
}

/**
 * @description Seed a campanha under expert (composite FK expert_id+empresa_id).
 * @param {DatabaseSync} db
 * @param {{
 *   empresaId: string,
 *   expertId: string,
 *   id?: string,
 *   nome?: string,
 *   tipo?: string,
 *   status?: string,
 * }} opts
 */
function seedCampanha(db, opts) {
  const id = opts.id ?? crypto.randomUUID();
  const nome = opts.nome ?? "Campanha Seed";
  const tipo = opts.tipo ?? "gratuito";
  const status = opts.status ?? "aberta";
  db.prepare(
    `INSERT INTO campanhas (id, empresa_id, expert_id, nome, tipo, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.empresaId, opts.expertId, nome, tipo, status);
  return {
    id,
    nome,
    tipo,
    status,
    empresaId: opts.empresaId,
    expertId: opts.expertId,
  };
}

/**
 * @description Mint session (optional active empresa) and return Cookie header + raw token.
 * @param {DatabaseSync} db
 * @param {string} userId
 * @param {string | null} [activeEmpresaId]
 */
async function sessionFor(db, userId, activeEmpresaId = null) {
  const rawToken = await mintSession(db, userId, activeEmpresaId);
  const setCookie = buildSessionCookie(rawToken);
  const token = setCookie.split(";")[0]?.split("=").slice(1).join("=");
  assert.ok(token && token.length > 0, "minted session token");
  return {
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    rawToken,
  };
}

/**
 * @description POST JSON helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 */
async function postJson(app, path, body, extraHeaders = {}) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/**
 * @description PUT JSON helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 */
async function putJson(app, path, body, extraHeaders = {}) {
  return app.request(path, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/**
 * @description GET helper against Hono app.
 * @param {import('hono').Hono} app
 * @param {string} path
 * @param {Record<string, string>} [extraHeaders]
 */
async function getJson(app, path, extraHeaders = {}) {
  return app.request(path, {
    method: "GET",
    headers: { ...extraHeaders },
  });
}

/**
 * @description Read empresa_llm_settings row by empresa_id (or null).
 * @param {DatabaseSync} db
 * @param {string} empresaId
 */
function llmSettingsRow(db, empresaId) {
  return (
    db
      .prepare(
        `SELECT empresa_id, provider, api_key_ciphertext, api_key_iv,
                status, validated_at, last_error
         FROM empresa_llm_settings WHERE empresa_id = ?`,
      )
      .get(empresaId) ?? null
  );
}

/**
 * @description Assert body is Metadata DTO shape (keys only; values checked by caller).
 * @param {unknown} body
 */
function assertMetadataDtoShape(body) {
  assert.ok(body && typeof body === "object", "body is object");
  assert.ok("provider" in body, "Metadata has provider");
  assert.ok("has_key" in body, "Metadata has has_key");
  assert.ok("status" in body, "Metadata has status");
  assert.ok("validated_at" in body, "Metadata has validated_at");
  assert.ok("last_error" in body, "Metadata has last_error");
}

/**
 * @description Assert serialized response text has no secret key material fields with values.
 * @param {string} text
 * @param {string} [plaintextKey]
 */
function assertNoKeyMaterialInText(text, plaintextKey) {
  if (plaintextKey) {
    assert.equal(
      text.includes(plaintextKey),
      false,
      "response must not include plaintext api key",
    );
  }
  // Reject secret-bearing keys with non-null values in JSON (api_key, ciphertext, iv).
  assert.equal(
    /"api_key"\s*:\s*"[^"]+"/i.test(text),
    false,
    "response must not include api_key secret value",
  );
  assert.equal(
    /"api_key_ciphertext"\s*:\s*"[^"]+"/i.test(text),
    false,
    "response must not include api_key_ciphertext value",
  );
  assert.equal(
    /"ciphertext"\s*:\s*"[^"]+"/i.test(text),
    false,
    "response must not include ciphertext value",
  );
  assert.equal(
    /"api_key_iv"\s*:\s*"[^"]+"/i.test(text),
    false,
    "response must not include api_key_iv value",
  );
  assert.equal(
    /"iv"\s*:\s*"[^"]+"/i.test(text),
    false,
    "response must not include iv secret value",
  );
}

/**
 * @description Default deps with encryption secret and optional probe.
 * @param {{
 *   llmKeyEncryptionSecret?: string | undefined,
 *   llmProbe?: (args: { provider: string, apiKey: string }) => Promise<
 *     | { ok: true }
 *     | { ok: false, kind: 'auth_rejected' | 'incomplete', message?: string }
 *   >,
 * }} [overrides]
 */
function appDeps(overrides = {}) {
  /** @type {{ llmKeyEncryptionSecret?: string, llmProbe?: typeof overrides.llmProbe }} */
  const deps = {
    llmKeyEncryptionSecret:
      "llmKeyEncryptionSecret" in overrides
        ? overrides.llmKeyEncryptionSecret
        : TEST_ENCRYPTION_SECRET,
  };
  if (overrides.llmProbe) {
    deps.llmProbe = overrides.llmProbe;
  }
  return deps;
}

/**
 * @description Seed admin + active empresa; return { db, admin, emp, cookie, app }.
 * @param {{
 *   empId?: string,
 *   adminEmail?: string,
 *   deps?: ReturnType<typeof appDeps>,
 * }} [opts]
 */
async function seedAdminEmpresa(opts = {}) {
  const db = openDb();
  const admin = await seedUser(db, {
    email: opts.adminEmail ?? "admin-llm@example.com",
    name: "Admin LLM",
  });
  const emp = seedEmpresa(db, {
    id: opts.empId ?? "emp-llm-a",
    nome: "Empresa LLM A",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: admin.id,
    papel: "admin",
  });
  const { cookie } = await sessionFor(db, admin.id, emp.id);
  const app = createEmpresaApp(db, opts.deps ?? appDeps());
  return { db, admin, emp, cookie, app };
}

// ─── lt-get-settings-admin-metadata ────────────────────────────────────────

/**
 * @description Admin GET llm-settings with no row returns Metadata status none, has_key false; no secret keys.
 */
test("lt-get-settings-admin-metadata: no row → 200 status none has_key false; no api_key/ciphertext/iv secrets", async () => {
  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-get-none",
    adminEmail: "admin-get-none@example.com",
  });

  const res = await getJson(app, LLM_SETTINGS_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "GET returns 200");
  const text = await res.text();
  const body = JSON.parse(text);

  assertMetadataDtoShape(body);
  assert.equal(body.status, "none", "status 'none' means no row");
  assert.equal(body.has_key, false, "has_key false when no row");
  assertNoKeyMaterialInText(text);

  db.close();
});

// ─── lt-get-settings-membro-403 ────────────────────────────────────────────

/**
 * @description Membro GET llm-settings is forbidden (403).
 */
test("lt-get-settings-membro-403: membro GET llm-settings → 403", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-get-llm@example.com",
    name: "Membro Get LLM",
  });
  const emp = seedEmpresa(db, { id: "emp-llm-membro-get", nome: "Empresa M" });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });

  const app = createEmpresaApp(db, appDeps());
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const res = await getJson(app, LLM_SETTINGS_PATH, { Cookie: cookie });
  assert.equal(res.status, 403, "membro GET settings forbidden");

  db.close();
});

// ─── lt-put-settings-metadata-no-key-echo ──────────────────────────────────

/**
 * @description Admin PUT encrypts key; Metadata has_key true unvalidated; response excludes plaintext; DB stores ciphertext.
 */
test("lt-put-settings-metadata-no-key-echo: PUT sk-test-secret-value-xyz → 200 unvalidated has_key true; no plaintext; DB ciphertext", async () => {
  const { db, emp, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-put-echo",
    adminEmail: "admin-put-echo@example.com",
  });

  const res = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: PLAINTEXT_KEY },
    { Cookie: cookie },
  );
  assert.equal(res.status, 200, "PUT returns 200");
  const text = await res.text();
  const body = JSON.parse(text);

  assertMetadataDtoShape(body);
  assert.equal(body.has_key, true, "has_key true after PUT");
  assert.equal(body.status, "unvalidated", "status resets to unvalidated");
  assert.equal(body.provider, "openai");
  assert.equal(
    text.includes(PLAINTEXT_KEY),
    false,
    "full response text must not include plaintext key",
  );
  assertNoKeyMaterialInText(text, PLAINTEXT_KEY);

  const row = llmSettingsRow(db, emp.id);
  assert.ok(row, "DB row exists after PUT");
  assert.equal(typeof row.api_key_ciphertext, "string");
  assert.ok(row.api_key_ciphertext.length > 0, "ciphertext stored");
  assert.notEqual(
    row.api_key_ciphertext,
    PLAINTEXT_KEY,
    "DB must not store plaintext as ciphertext",
  );
  assert.equal(
    String(row.api_key_ciphertext).includes(PLAINTEXT_KEY),
    false,
    "ciphertext must not contain plaintext substring",
  );
  assert.equal(row.status, "unvalidated");
  assert.equal(row.provider, "openai");

  db.close();
});

// ─── lt-put-missing-secret-503 ─────────────────────────────────────────────

/**
 * @description Missing/empty/whitespace encryption secret on PUT → 503 Service unavailable; no plaintext persisted.
 */
test("lt-put-missing-secret-503: undefined/empty secret → 503 Service unavailable; no plaintext persisted", async () => {
  for (const secret of [undefined, "", "   "]) {
    const db = openDb();
    const admin = await seedUser(db, {
      email: `admin-put-503-${String(secret)}@example.com`,
      name: "Admin Put 503",
    });
    const emp = seedEmpresa(db, {
      id: `emp-llm-put-503-${secret === undefined ? "undef" : "empty"}`,
      nome: "Empresa Put 503",
    });
    seedMembership(db, {
      empresaId: emp.id,
      userId: admin.id,
      papel: "admin",
    });
    const { cookie } = await sessionFor(db, admin.id, emp.id);
    const app = createEmpresaApp(
      db,
      appDeps({ llmKeyEncryptionSecret: secret }),
    );

    const plaintext = `sk-must-not-persist-${secret === undefined ? "u" : "e"}`;
    const res = await putJson(
      app,
      LLM_SETTINGS_PATH,
      { provider: "openai", api_key: plaintext },
      { Cookie: cookie },
    );
    assert.equal(res.status, 503, `secret=${JSON.stringify(secret)} → 503`);
    const body = await res.json();
    assert.deepEqual(body, { error: "Service unavailable" });

    const row = llmSettingsRow(db, emp.id);
    if (row) {
      assert.notEqual(
        row.api_key_ciphertext,
        plaintext,
        "must not persist plaintext as ciphertext",
      );
      assert.equal(
        row.api_key_ciphertext == null ||
          !String(row.api_key_ciphertext).includes(plaintext),
        true,
        "must not persist plaintext in ciphertext column",
      );
    }
    // Also scan all ciphertext values for this empresa
    const anyPlain = db
      .prepare(
        `SELECT COUNT(*) AS c FROM empresa_llm_settings
         WHERE empresa_id = ?
           AND (api_key_ciphertext = ? OR api_key_ciphertext LIKE ?)`,
      )
      .get(emp.id, plaintext, `%${plaintext}%`);
    assert.equal(Number(anyPlain.c), 0, "no plaintext key persisted");

    db.close();
  }
});

// ─── lt-validate-valid-200 ─────────────────────────────────────────────────

/**
 * @description Probe success → Metadata status valid, validated_at set, last_error null; no plaintext in body.
 */
test("lt-validate-valid-200: probe success → status valid, validated_at set, last_error null", async () => {
  const plaintext = "sk-validate-valid-key";
  const probe = async () => /** @type {const} */ ({ ok: true });

  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-val-ok",
    adminEmail: "admin-val-ok@example.com",
    deps: appDeps({ llmProbe: probe }),
  });

  const putRes = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: plaintext },
    { Cookie: cookie },
  );
  assert.equal(putRes.status, 200);

  const res = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie });
  assert.equal(res.status, 200, "validate success returns 200");
  const text = await res.text();
  const body = JSON.parse(text);

  assertMetadataDtoShape(body);
  assert.equal(body.status, "valid");
  assert.ok(body.validated_at != null, "validated_at non-null");
  assert.notEqual(body.validated_at, "", "validated_at non-empty");
  assert.equal(body.last_error, null);
  assert.equal(
    text.includes(plaintext),
    false,
    "response excludes plaintext key",
  );
  assertNoKeyMaterialInText(text, plaintext);

  db.close();
});

// ─── lt-validate-invalid-200 ───────────────────────────────────────────────

/**
 * @description Probe auth rejection → 200 Metadata status invalid, safe last_error, no key in body.
 */
test("lt-validate-invalid-200: probe auth reject → status invalid, safe last_error, no key in body", async () => {
  const plaintext = "sk-validate-invalid-key";
  const probe = async () =>
    /** @type {const} */ ({
      ok: false,
      kind: "auth_rejected",
      message: "Invalid API key",
    });

  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-val-bad",
    adminEmail: "admin-val-bad@example.com",
    deps: appDeps({ llmProbe: probe }),
  });

  const putRes = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: plaintext },
    { Cookie: cookie },
  );
  assert.equal(putRes.status, 200);

  const res = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie });
  assert.equal(res.status, 200, "auth reject still returns 200 Metadata");
  const text = await res.text();
  const body = JSON.parse(text);

  assertMetadataDtoShape(body);
  assert.equal(body.status, "invalid");
  assert.equal(typeof body.last_error, "string");
  assert.ok(
    body.last_error.length > 0,
    "last_error is a non-empty safe string",
  );
  assert.equal(
    body.last_error.includes(plaintext),
    false,
    "last_error must not embed plaintext key",
  );
  assert.equal(text.includes(plaintext), false, "response excludes plaintext");
  assertNoKeyMaterialInText(text, plaintext);

  db.close();
});

// ─── lt-validate-timeout-502 ───────────────────────────────────────────────

/**
 * @description Probe incomplete/timeout → 502 Validation failed; no plaintext in body.
 */
test("lt-validate-timeout-502: probe incomplete → 502 Validation failed", async () => {
  const plaintext = "sk-validate-timeout-key";
  const probe = async () =>
    /** @type {const} */ ({
      ok: false,
      kind: "incomplete",
      message: "timeout",
    });

  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-val-to",
    adminEmail: "admin-val-to@example.com",
    deps: appDeps({ llmProbe: probe }),
  });

  const putRes = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: plaintext },
    { Cookie: cookie },
  );
  assert.equal(putRes.status, 200);

  const res = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie });
  assert.equal(res.status, 502, "incomplete probe → 502");
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(body, { error: "Validation failed" });
  assert.equal(text.includes(plaintext), false, "response excludes plaintext");

  db.close();
});

// ─── lt-validate-missing-secret-503 ────────────────────────────────────────

/**
 * @description Missing encryption secret on validate → 503 Service unavailable.
 */
test("lt-validate-missing-secret-503: missing secret → admin POST validate 503 Service unavailable", async () => {
  const db = openDb();
  const admin = await seedUser(db, {
    email: "admin-val-503@example.com",
    name: "Admin Val 503",
  });
  const emp = seedEmpresa(db, { id: "emp-llm-val-503", nome: "Empresa Val 503" });
  seedMembership(db, {
    empresaId: emp.id,
    userId: admin.id,
    papel: "admin",
  });
  // Pre-seed a settings row so validate is not blocked solely by missing key row
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, api_key_ciphertext, api_key_iv, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(emp.id, "openai", "deadbeef", "00112233445566778899aabb", "unvalidated");

  const { cookie } = await sessionFor(db, admin.id, emp.id);
  const app = createEmpresaApp(
    db,
    appDeps({ llmKeyEncryptionSecret: undefined }),
  );

  const res = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Service unavailable" });

  db.close();
});

// ─── lt-membro-put-validate-403 ────────────────────────────────────────────

/**
 * @description Membro cannot PUT settings or POST validate (both 403).
 */
test("lt-membro-put-validate-403: membro PUT llm-settings or POST validate → both 403", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-put-val@example.com",
    name: "Membro Put Val",
  });
  const emp = seedEmpresa(db, {
    id: "emp-llm-membro-write",
    nome: "Empresa Membro Write",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });

  const app = createEmpresaApp(db, appDeps());
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const putRes = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: "sk-membro-blocked" },
    { Cookie: cookie },
  );
  assert.equal(putRes.status, 403, "membro PUT forbidden");

  const valRes = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie });
  assert.equal(valRes.status, 403, "membro validate forbidden");

  db.close();
});

// ─── lt-health-unvalidated-after-put ───────────────────────────────────────

/**
 * @description After PUT without validate, health returns ok false llm_key_unvalidated; no key material.
 */
test("lt-health-unvalidated-after-put: after PUT without validate → 200 { ok:false, reason:'llm_key_unvalidated' }", async () => {
  const { db, cookie, app, admin, emp } = await seedAdminEmpresa({
    empId: "emp-llm-health-unval",
    adminEmail: "admin-health-unval@example.com",
  });

  const putRes = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: PLAINTEXT_KEY },
    { Cookie: cookie },
  );
  assert.equal(putRes.status, 200);

  // Any member — use admin session (also member)
  const res = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "llm_key_unvalidated");
  assertNoKeyMaterialInText(text, PLAINTEXT_KEY);

  // Also as membro
  const membro = await seedUser(db, {
    email: "membro-health-unval@example.com",
    name: "Membro Health Unval",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });
  const { cookie: membroCookie } = await sessionFor(db, membro.id, emp.id);
  const membroRes = await getJson(app, LLM_HEALTH_PATH, {
    Cookie: membroCookie,
  });
  assert.equal(membroRes.status, 200);
  const membroBody = await membroRes.json();
  assert.equal(membroBody.ok, false);
  assert.equal(membroBody.reason, "llm_key_unvalidated");

  void admin;
  db.close();
});

// ─── lt-health-valid-ok-true ───────────────────────────────────────────────

/**
 * @description After successful validate, health returns ok true with no key material.
 */
test("lt-health-valid-ok-true: status valid after validate → GET health 200 { ok: true }", async () => {
  const plaintext = "sk-health-valid-key";
  const probe = async () => /** @type {const} */ ({ ok: true });

  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-health-ok",
    adminEmail: "admin-health-ok@example.com",
    deps: appDeps({ llmProbe: probe }),
  });

  assert.equal(
    (
      await putJson(
        app,
        LLM_SETTINGS_PATH,
        { provider: "openai", api_key: plaintext },
        { Cookie: cookie },
      )
    ).status,
    200,
  );
  assert.equal(
    (await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie })).status,
    200,
  );

  const res = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(
    "reason" in body ? body.reason : undefined,
    undefined,
    "ok true has no failure reason (or reason absent)",
  );
  // If reason is present it must not be a failure reason
  if ("reason" in body && body.reason != null) {
    assert.notEqual(body.reason, "llm_key_unvalidated");
    assert.notEqual(body.reason, "llm_key_invalid");
    assert.notEqual(body.reason, "llm_not_configured");
    assert.notEqual(body.reason, "llm_key_missing");
  }
  assertNoKeyMaterialInText(text, plaintext);

  db.close();
});

// ─── lt-health-not-configured ──────────────────────────────────────────────

/**
 * @description No empresa_llm_settings row → health llm_not_configured.
 */
test("lt-health-not-configured: no row → 200 { ok:false, reason:'llm_not_configured' }", async () => {
  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-health-none",
    adminEmail: "admin-health-none@example.com",
  });

  const res = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "llm_not_configured");
  assertNoKeyMaterialInText(text);

  db.close();
});

// ─── lt-health-key-missing ─────────────────────────────────────────────────

/**
 * @description Row with null ciphertext (has_key false) → health llm_key_missing.
 */
test("lt-health-key-missing: row with null ciphertext → 200 { ok:false, reason:'llm_key_missing' }", async () => {
  const { db, emp, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-health-miss",
    adminEmail: "admin-health-miss@example.com",
  });

  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, api_key_ciphertext, api_key_iv, status, validated_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(emp.id, null, null, null, "unvalidated", null, null);

  const res = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "llm_key_missing");
  assertNoKeyMaterialInText(text);

  db.close();
});

// ─── lt-health-key-invalid ─────────────────────────────────────────────────

/**
 * @description After failed validate (status invalid) → health llm_key_invalid.
 */
test("lt-health-key-invalid: after invalid validate → 200 { ok:false, reason:'llm_key_invalid' }", async () => {
  const plaintext = "sk-health-invalid-key";
  const probe = async () =>
    /** @type {const} */ ({
      ok: false,
      kind: "auth_rejected",
      message: "bad key",
    });

  const { db, cookie, app } = await seedAdminEmpresa({
    empId: "emp-llm-health-inv",
    adminEmail: "admin-health-inv@example.com",
    deps: appDeps({ llmProbe: probe }),
  });

  assert.equal(
    (
      await putJson(
        app,
        LLM_SETTINGS_PATH,
        { provider: "openai", api_key: plaintext },
        { Cookie: cookie },
      )
    ).status,
    200,
  );
  const valRes = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookie });
  assert.equal(valRes.status, 200);
  const valBody = await valRes.json();
  assert.equal(valBody.status, "invalid");

  const res = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookie });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "llm_key_invalid");
  assertNoKeyMaterialInText(text, plaintext);

  db.close();
});

// ─── lt-health-membro-200 ──────────────────────────────────────────────────

/**
 * @description Membro can GET health (200, not 403) with ok boolean and optional reason.
 */
test("lt-health-membro-200: membro GET health → 200 (not 403) with ok boolean and optional reason", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-health-ok@example.com",
    name: "Membro Health",
  });
  const emp = seedEmpresa(db, {
    id: "emp-llm-health-membro",
    nome: "Empresa Health Membro",
  });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });

  const app = createEmpresaApp(db, appDeps());
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const res = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookie });
  assert.equal(res.status, 200, "membro health is 200 not 403");
  const body = await res.json();
  assert.equal(typeof body.ok, "boolean");
  if ("reason" in body && body.reason != null) {
    assert.equal(typeof body.reason, "string");
  }

  db.close();
});

// ─── lt-tarefas-crud-without-valid-key ─────────────────────────────────────

/**
 * @description Tarefas create/list still succeed without valid LLM key (domain CRUD ignores LLM health).
 */
test("lt-tarefas-crud-without-valid-key: create/list tarefa still works without valid LLM", async () => {
  const db = openDb();
  const membro = await seedUser(db, {
    email: "membro-tar-llm@example.com",
    name: "Membro Tar LLM",
  });
  const emp = seedEmpresa(db, { id: "emp-llm-tar", nome: "Empresa Tar LLM" });
  seedMembership(db, {
    empresaId: emp.id,
    userId: membro.id,
    papel: "membro",
  });
  const expert = seedExpert(db, {
    empresaId: emp.id,
    id: "ex-llm-tar",
    nome: "Expert Tar LLM",
  });
  const campanha = seedCampanha(db, {
    empresaId: emp.id,
    expertId: expert.id,
    id: "camp-llm-tar",
    nome: "Campanha Tar LLM",
  });

  // No LLM row (and no valid key)
  assert.equal(llmSettingsRow(db, emp.id), null);

  const app = createEmpresaApp(db, appDeps());
  const { cookie } = await sessionFor(db, membro.id, emp.id);

  const createRes = await postJson(
    app,
    TAREFAS_PATH,
    { campanha_id: campanha.id, titulo: "Tarefa without LLM" },
    { Cookie: cookie },
  );
  assert.equal(
    createRes.status,
    201,
    "create tarefa not blocked by missing LLM",
  );
  const created = await createRes.json();
  assert.equal(typeof created.id, "string");

  const listRes = await getJson(
    app,
    `/api/empresa/campanhas/${campanha.id}/tarefas`,
    { Cookie: cookie },
  );
  assert.equal(listRes.status, 200, "list tarefas not blocked by missing LLM");
  const listBody = await listRes.json();
  const items = Array.isArray(listBody)
    ? listBody
    : Array.isArray(listBody?.tarefas)
      ? listBody.tarefas
      : null;
  assert.ok(items, "list body is array or {tarefas:[]}");
  const ids = new Set(
    items
      .filter((t) => t && typeof t === "object" && typeof t.id === "string")
      .map((t) => t.id),
  );
  assert.ok(ids.has(created.id), "created tarefa appears in list");

  db.close();
});

// ─── lt-cross-tenant-key-isolation ─────────────────────────────────────────

/**
 * @description Empresa B never sees A's plaintext key, ciphertext/iv, or A's has_key/provider as B's config.
 */
test("lt-cross-tenant-key-isolation: B never sees sk-tenant-a-secret or A's config", async () => {
  const db = openDb();
  const adminA = await seedUser(db, {
    email: "admin-a-iso@example.com",
    name: "Admin A Iso",
  });
  const adminB = await seedUser(db, {
    email: "admin-b-iso@example.com",
    name: "Admin B Iso",
  });
  const empA = seedEmpresa(db, { id: "emp-llm-iso-a", nome: "Empresa A Iso" });
  const empB = seedEmpresa(db, { id: "emp-llm-iso-b", nome: "Empresa B Iso" });
  seedMembership(db, {
    empresaId: empA.id,
    userId: adminA.id,
    papel: "admin",
  });
  seedMembership(db, {
    empresaId: empB.id,
    userId: adminB.id,
    papel: "admin",
  });

  const app = createEmpresaApp(db, appDeps());
  const { cookie: cookieA } = await sessionFor(db, adminA.id, empA.id);
  const { cookie: cookieB } = await sessionFor(db, adminB.id, empB.id);

  const putA = await putJson(
    app,
    LLM_SETTINGS_PATH,
    { provider: "openai", api_key: TENANT_A_KEY },
    { Cookie: cookieA },
  );
  assert.equal(putA.status, 200);
  const metaA = await putA.json();
  assert.equal(metaA.has_key, true);
  assert.equal(metaA.provider, "openai");

  const rowA = llmSettingsRow(db, empA.id);
  assert.ok(rowA);
  assert.ok(rowA.api_key_ciphertext);
  assert.ok(rowA.api_key_iv);
  const ciphertextA = String(rowA.api_key_ciphertext);
  const ivA = String(rowA.api_key_iv);

  const paths = [LLM_SETTINGS_PATH, LLM_HEALTH_PATH];
  for (const path of paths) {
    const res = await getJson(app, path, { Cookie: cookieB });
    const text = await res.text();
    assert.equal(
      text.includes(TENANT_A_KEY),
      false,
      `B ${path} must not contain A's plaintext key`,
    );
    assert.equal(
      text.includes(ciphertextA),
      false,
      `B ${path} must not contain A's ciphertext`,
    );
    assert.equal(
      text.includes(ivA),
      false,
      `B ${path} must not contain A's iv`,
    );
  }

  // B GET settings Metadata must not present A's configuration as B's
  const getB = await getJson(app, LLM_SETTINGS_PATH, { Cookie: cookieB });
  assert.equal(getB.status, 200);
  const metaB = await getB.json();
  assertMetadataDtoShape(metaB);
  // B has no row → none / has_key false (not A's has_key true / openai)
  assert.equal(
    metaB.has_key,
    false,
    "B Metadata must not show A's has_key as B's",
  );
  assert.equal(
    metaB.status,
    "none",
    "B with no row must be status none, not A's config",
  );
  // provider must not be presented as if B inherited A's openai config
  assert.ok(
    metaB.provider == null || metaB.provider === null,
    "B provider must not be A's openai when B has no settings",
  );

  const healthB = await getJson(app, LLM_HEALTH_PATH, { Cookie: cookieB });
  assert.equal(healthB.status, 200);
  const healthBody = await healthB.json();
  assert.equal(healthBody.ok, false);
  assert.equal(healthBody.reason, "llm_not_configured");

  // Validate as B must also not leak A
  const valB = await postJson(app, LLM_VALIDATE_PATH, {}, { Cookie: cookieB });
  const valText = await valB.text();
  assert.equal(valText.includes(TENANT_A_KEY), false);
  assert.equal(valText.includes(ciphertextA), false);
  assert.equal(valText.includes(ivA), false);

  db.close();
});
