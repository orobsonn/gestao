/**
 * Locked empresa LLM model-write contract.
 * Hermetic: node:sqlite + Hono app.request via createEmpresaApp(db, deps).
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
const SETTINGS_PATH = "/api/empresa/llm-settings";
const ENCRYPTION_SECRET = "hermetic-model-write-encryption-secret";
const INITIAL_STATE = {
  provider: "openai",
  model_id: "gpt-5.6-sol",
  api_key_ciphertext: "cipher-before",
  api_key_iv: "iv-before",
  status: "valid",
  validated_at: "2026-08-01 10:00:00",
  last_error: "prior-error",
};

/** @description Opens an in-memory database and applies all migrations lexically. */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

/** @description Reads every model, key, and validation field pinned by this contract. */
function readSettings(db, empresaId) {
  return db
    .prepare(
      `SELECT provider, model_id, api_key_ciphertext, api_key_iv,
              status, validated_at, last_error
       FROM empresa_llm_settings WHERE empresa_id = ?`,
    )
    .get(empresaId);
}

/** @description Seeds an authenticated admin with persisted OpenAI settings. */
async function seedFixture(suffix) {
  const db = openDb();
  const userId = `user-model-write-${suffix}`;
  const empresaId = `empresa-model-write-${suffix}`;
  const { hash, salt } = await hashPassword("secure-pass-ok");

  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, ?, ?, 'user')`,
  ).run(
    userId,
    `admin-model-write-${suffix}@example.com`,
    `Admin Model Write ${suffix}`,
    hash,
    salt,
  );
  db.prepare("INSERT INTO empresas (id, nome) VALUES (?, ?)").run(
    empresaId,
    `Empresa Model Write ${suffix}`,
  );
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, 'admin')`,
  ).run(`membership-model-write-${suffix}`, empresaId, userId);
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, model_id, api_key_ciphertext, api_key_iv,
        status, validated_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    empresaId,
    INITIAL_STATE.provider,
    INITIAL_STATE.model_id,
    INITIAL_STATE.api_key_ciphertext,
    INITIAL_STATE.api_key_iv,
    INITIAL_STATE.status,
    INITIAL_STATE.validated_at,
    INITIAL_STATE.last_error,
  );

  const rawToken = await mintSession(db, userId, empresaId);
  const token = buildSessionCookie(rawToken)
    .split(";")[0]
    ?.split("=")
    .slice(1)
    .join("=");
  assert.ok(token, "minted session token");
  return {
    db,
    empresaId,
    cookie: `gestao_session=${token}`,
  };
}

/** @description Creates the empresa app with the hermetic encryption secret. */
function createApp(db) {
  return createEmpresaApp(db, {
    llmKeyEncryptionSecret: ENCRYPTION_SECRET,
  });
}

/** @description Sends one authenticated JSON PUT to the settings endpoint. */
function putSettings(app, cookie, body) {
  return app.request(SETTINGS_PATH, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** @description Verifies an error response has the exact pinned status and body. */
async function assertError(response, status, error) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
}

/** @description Strict PUT parsing rejects mixed and extra-key payloads without persistence. */
test("lt-strict-exclusive-put-union: mixed and extra-key payloads return 400 without writes", async () => {
  const fixture = await seedFixture("strict-union");
  const app = createApp(fixture.db);
  const payloads = [
    {
      model_id: "gpt-5.6-luna",
      provider: "anthropic",
      api_key: "key-new",
    },
    { model_id: "gpt-5.6-luna", extra: true },
    { provider: "anthropic", api_key: "key-new", extra: true },
  ];

  for (const payload of payloads) {
    await assertError(
      await putSettings(app, fixture.cookie, payload),
      400,
      "Invalid request",
    );
    assert.deepEqual(
      { ...readSettings(fixture.db, fixture.empresaId) },
      INITIAL_STATE,
    );
  }
  fixture.db.close();
});

/** @description A model outside the persisted provider catalog is rejected without a write. */
test("lt-reject-uncurated-model-without-write: embedding model returns 400 and preserves model_id", async () => {
  const fixture = await seedFixture("uncurated");
  const app = createApp(fixture.db);

  await assertError(
    await putSettings(app, fixture.cookie, {
      model_id: "text-embedding-3-large",
    }),
    400,
    "Invalid model",
  );
  assert.equal(
    readSettings(fixture.db, fixture.empresaId).model_id,
    "gpt-5.6-sol",
  );
  fixture.db.close();
});

/** @description A model-only save changes only model_id and preserves key-validation state. */
test("lt-model-only-preserves-key-validation-state: exact model-only PUT preserves provider, key, and validation fields", async () => {
  const fixture = await seedFixture("model-only");
  const app = createApp(fixture.db);

  const response = await putSettings(app, fixture.cookie, {
    model_id: "gpt-5.6-luna",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    { ...readSettings(fixture.db, fixture.empresaId) },
    { ...INITIAL_STATE, model_id: "gpt-5.6-luna" },
  );
  fixture.db.close();
});

/** @description Wraps the DB to replace provider/key immediately before the first conditional model update. */
function forceProviderRace(db, empresaId) {
  const observations = {
    conditionalModelWrites: 0,
    postConflictReloads: 0,
    incompatibleModelObserved: false,
    conflictForced: false,
  };

  return {
    observations,
    db: new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql) => {
          const statement = target.prepare(sql);
          const normalized = String(sql).replace(/\s+/g, " ").toLowerCase();
          const isModelUpdate =
            normalized.startsWith("update empresa_llm_settings") &&
            normalized.includes("set model_id") &&
            normalized.includes("and provider");
          const isSettingsLoad =
            normalized.startsWith("select empresa_id, provider") &&
            normalized.includes("from empresa_llm_settings where empresa_id = ?");

          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "get" && isModelUpdate) {
                return (...args) => {
                  observations.conditionalModelWrites += 1;
                  if (!observations.conflictForced) {
                    observations.conflictForced = true;
                    target
                      .prepare(
                        `UPDATE empresa_llm_settings
                         SET provider = 'anthropic', model_id = NULL,
                             api_key_ciphertext = 'cipher-race',
                             api_key_iv = 'iv-race', status = 'unvalidated',
                             validated_at = NULL, last_error = NULL
                         WHERE empresa_id = ?`,
                      )
                      .run(empresaId);
                  }
                  const result = statementTarget.get(...args);
                  const row = readSettings(target, empresaId);
                  if (
                    row.provider === "anthropic" &&
                    typeof row.model_id === "string" &&
                    row.model_id.startsWith("gpt-")
                  ) {
                    observations.incompatibleModelObserved = true;
                  }
                  return result;
                };
              }
              if (statementProperty === "get" && isSettingsLoad) {
                return (...args) => {
                  if (observations.conflictForced) {
                    observations.postConflictReloads += 1;
                  }
                  return statementTarget.get(...args);
                };
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      },
    }),
  };
}

/** @description A provider-change race conflicts, reloads once, and never stores an incompatible model. */
test("lt-forced-provider-model-save-race: provider replacement before conditional update returns 409 and leaves null model", async () => {
  const fixture = await seedFixture("race");
  const raced = forceProviderRace(fixture.db, fixture.empresaId);
  const app = createApp(raced.db);

  await assertError(
    await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-luna" }),
    409,
    "Settings changed",
  );
  assert.equal(raced.observations.conditionalModelWrites, 1);
  // Exactly ONE post-conflict read, and it is NOT a retry: a failed CAS means the row this
  // decision was made against is gone, so re-writing would re-attach the model to whatever
  // replaced it — the lost update the predicate exists to prevent. The single read only asks
  // whether the winning row already converged on what was requested; here it did not, so 409.
  assert.equal(raced.observations.postConflictReloads, 1);
  assert.equal(raced.observations.conditionalModelWrites, 1, "no second write attempt");
  assert.equal(raced.observations.incompatibleModelObserved, false);
  const row = readSettings(fixture.db, fixture.empresaId);
  assert.deepEqual(
    { provider: row.provider, model_id: row.model_id },
    { provider: "anthropic", model_id: null },
  );
  fixture.db.close();
});

/** @description Provider/key replacement clears model_id and returns unvalidated metadata. */
test("lt-provider-replacement-clears-model: Anthropic credential replacement atomically clears the OpenAI model", async () => {
  const fixture = await seedFixture("provider-replacement");
  const app = createApp(fixture.db);

  const response = await putSettings(app, fixture.cookie, {
    provider: "anthropic",
    api_key: "key-anthropic",
  });
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.model_id, null);
  const row = readSettings(fixture.db, fixture.empresaId);
  assert.equal(row.provider, "anthropic");
  assert.equal(row.model_id, null);
  assert.equal(row.status, "unvalidated");
  fixture.db.close();
});

/** @description Every excluded model family and unknown identifier is rejected for both providers without writes. */
test("lt-reject-every-excluded-family: both providers reject excluded model families and preserve prior model_id", async () => {
  const excludedByProvider = {
    openai: [
      "gpt-image-1",
      "gpt-4o-audio-preview",
      "omni-moderation-latest",
      "text-embedding-3-large",
      "gpt-4o-realtime-preview",
      "gpt-4o-transcribe",
      "ft:gpt-5.6-sol:empresa:custom",
      "unknown-model",
    ],
    anthropic: [
      "claude-image-1",
      "claude-audio-1",
      "claude-moderation-1",
      "claude-embedding-1",
      "claude-realtime-1",
      "claude-transcription-1",
      "ft:claude-sonnet-5:empresa:custom",
      "unknown-model",
    ],
  };

  for (const [provider, excludedModels] of Object.entries(excludedByProvider)) {
    const fixture = await seedFixture(`excluded-${provider}`);
    const priorModel =
      provider === "openai" ? "gpt-5.6-sol" : "claude-sonnet-5";
    fixture.db
      .prepare(
        `UPDATE empresa_llm_settings
         SET provider = ?, model_id = ? WHERE empresa_id = ?`,
      )
      .run(provider, priorModel, fixture.empresaId);
    const app = createApp(fixture.db);

    for (const modelId of excludedModels) {
      await assertError(
        await putSettings(app, fixture.cookie, { model_id: modelId }),
        400,
        "Invalid model",
      );
      assert.equal(
        readSettings(fixture.db, fixture.empresaId).model_id,
        priorModel,
      );
    }
    fixture.db.close();
  }
});

/**
 * @description Clearing is wire-shaped as an explicit null. The empty string is rejected: it would
 * persist a value the turn path cannot resolve, and the empresa's bot would go silent.
 */
test("lt-model-clear-null-only: null restores the provider default and empty string is refused", async () => {
  const fixture = await seedFixture("clear-null");
  const app = createApp(fixture.db);

  const cleared = await putSettings(app, fixture.cookie, { model_id: null });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).model_id, null);
  assert.equal(readSettings(fixture.db, fixture.empresaId).model_id, null);

  await assertError(
    await putSettings(app, fixture.cookie, { model_id: "" }),
    400,
    "Invalid request",
  );
  assert.equal(readSettings(fixture.db, fixture.empresaId).model_id, null);

  // Clearing is reversible: the default itself is curated, so it can be chosen again explicitly.
  const rechosen = await putSettings(app, fixture.cookie, {
    model_id: "gpt-4o-mini",
  });
  assert.equal(rechosen.status, 200);
  assert.equal(readSettings(fixture.db, fixture.empresaId).model_id, "gpt-4o-mini");

  fixture.db.close();
});

/** @description Rotates the key in place immediately before the first conditional model update. */
function forceKeyRotationRace(db, empresaId) {
  let rotated = false;
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        const normalized = String(sql).replace(/\s+/g, " ").toLowerCase();
        const isModelUpdate =
          normalized.startsWith("update empresa_llm_settings") &&
          normalized.includes("set model_id");
        if (!isModelUpdate) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            const value = Reflect.get(
              statementTarget,
              statementProperty,
              statementTarget,
            );
            if (statementProperty !== "get") {
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            }
            return (...params) => {
              if (!rotated) {
                rotated = true;
                target
                  .prepare(
                    `UPDATE empresa_llm_settings
                     SET api_key_ciphertext = 'cipher-rotated',
                         api_key_iv = 'iv-rotated',
                         model_id = NULL,
                         status = 'unvalidated'
                     WHERE empresa_id = ?`,
                  )
                  .run(empresaId);
              }
              return value.apply(statementTarget, params);
            };
          },
        });
      };
    },
  });
}

/**
 * @description A same-provider key rotation deliberately resets model_id. A model PUT decided
 * against the pre-rotation row must not re-attach its model to the fresh credential.
 */
test("lt-model-cas-observes-key-identity: same-provider rotation makes an in-flight model PUT 409", async () => {
  const fixture = await seedFixture("cas-key-identity");
  const app = createApp(forceKeyRotationRace(fixture.db, fixture.empresaId));

  await assertError(
    await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-luna" }),
    409,
    "Settings changed",
  );

  const row = readSettings(fixture.db, fixture.empresaId);
  assert.deepEqual(
    { model_id: row.model_id, status: row.status, cipher: row.api_key_ciphertext },
    { model_id: null, status: "unvalidated", cipher: "cipher-rotated" },
    "the rotated credential keeps its reset model",
  );

  fixture.db.close();
});

/** @description A payload above the 16 KiB cap is refused before parsing, with nothing persisted. */
test("lt-oversized-put-body-refused: a body past the cap returns 400 and writes nothing", async () => {
  const fixture = await seedFixture("oversize");
  const app = createApp(fixture.db);

  // The ONLY defect is size: valid JSON, valid shape, a curated model that would otherwise be
  // saved. Padding a long model_id instead would also trip z.string().max(200) and the test
  // would pass with the cap removed.
  const padded = `{${" ".repeat(17 * 1024)}"model_id":"gpt-5.6-luna"}`;
  const response = await app.request(SETTINGS_PATH, {
    method: "PUT",
    headers: { Cookie: fixture.cookie, "Content-Type": "application/json" },
    body: padded,
  });
  await assertError(response, 400, "Invalid request");
  assert.deepEqual(
    { ...readSettings(fixture.db, fixture.empresaId) },
    INITIAL_STATE,
    "an oversized body must not touch the row",
  );

  fixture.db.close();
});

/**
 * @description A row whose model_id was stored padded (or blank) must stay saveable.
 *
 * The handler reads the column through a normalizer, so a CAS comparing that trimmed value against
 * the RAW column would never match and the empresa could never change model again — a permanent
 * 409 loop with no way out from the dashboard.
 */
test("lt-model-cas-tolerates-unnormalized-stored-value: a padded stored model is still saveable", async () => {
  const fixture = await seedFixture("cas-padded");
  const app = createApp(fixture.db);

  fixture.db
    .prepare(`UPDATE empresa_llm_settings SET model_id = '  gpt-5.6-sol  ' WHERE empresa_id = ?`)
    .run(fixture.empresaId);

  const response = await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-luna" });
  assert.equal(response.status, 200, "a padded stored value must not wedge the save");
  assert.equal(
    readSettings(fixture.db, fixture.empresaId).model_id,
    "gpt-5.6-luna",
  );

  // Blank is the other reachable un-normalized state.
  fixture.db
    .prepare(`UPDATE empresa_llm_settings SET model_id = '   ' WHERE empresa_id = ?`)
    .run(fixture.empresaId);
  const cleared = await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-terra" });
  assert.equal(cleared.status, 200, "a blank stored value must not wedge the save");

  // Non-ASCII whitespace is the same hazard: JS trim strips it, SQL TRIM must too, or the CAS
  // never matches and the empresa can never change model again.
  fixture.db
    .prepare(
      `UPDATE empresa_llm_settings SET model_id = char(12288) || 'gpt-5.6-sol' || char(10)
       WHERE empresa_id = ?`,
    )
    .run(fixture.empresaId);
  const unicodePadded = await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-luna" });
  assert.equal(
    unicodePadded.status,
    200,
    "unicode-padded stored value must not wedge the save either",
  );

  fixture.db.close();
});

/** @description Swaps only the model — same provider, same key — right before the conditional update. */
function forceModelChangeRace(db, empresaId) {
  let swapped = false;
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        const normalized = String(sql).replace(/\s+/g, " ").toLowerCase();
        if (
          !normalized.startsWith("update empresa_llm_settings") ||
          !normalized.includes("set model_id")
        ) {
          return statement;
        }
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            const value = Reflect.get(
              statementTarget,
              statementProperty,
              statementTarget,
            );
            if (statementProperty !== "get") {
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            }
            return (...params) => {
              if (!swapped) {
                swapped = true;
                target
                  .prepare(
                    `UPDATE empresa_llm_settings SET model_id = 'gpt-5.6-terra'
                     WHERE empresa_id = ?`,
                  )
                  .run(empresaId);
              }
              return value.apply(statementTarget, params);
            };
          },
        });
      };
    },
  });
}

/**
 * @description Two admins of the SAME empresa saving different models must not silently overwrite.
 *
 * Provider and key are untouched here, so only the prior-model half of the CAS predicate can catch
 * it — the key-rotation and provider-replacement races both fail on a different clause and would
 * stay green if that half were deleted.
 */
test("lt-model-cas-observes-prior-model: a concurrent model change makes the in-flight save 409", async () => {
  const fixture = await seedFixture("cas-prior-model");
  const app = createApp(forceModelChangeRace(fixture.db, fixture.empresaId));

  await assertError(
    await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-luna" }),
    409,
    "Settings changed",
  );

  const row = readSettings(fixture.db, fixture.empresaId);
  assert.equal(
    row.model_id,
    "gpt-5.6-terra",
    "the winning admin's model must survive; the loser must not overwrite it",
  );
  assert.equal(row.provider, INITIAL_STATE.provider, "provider untouched");
  assert.equal(
    row.api_key_ciphertext,
    INITIAL_STATE.api_key_ciphertext,
    "key untouched",
  );

  fixture.db.close();
});

/** @description Swaps the model to the SAME value this request is asking for, before the CAS. */
function forceConvergentRace(db, empresaId, targetModel) {
  let swapped = false;
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        const normalized = String(sql).replace(/\s+/g, " ").toLowerCase();
        if (
          !normalized.startsWith("update empresa_llm_settings") ||
          !normalized.includes("set model_id")
        ) {
          return statement;
        }
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            const value = Reflect.get(statementTarget, statementProperty, statementTarget);
            if (statementProperty !== "get") {
              return typeof value === "function" ? value.bind(statementTarget) : value;
            }
            return (...params) => {
              if (!swapped) {
                swapped = true;
                target
                  .prepare(`UPDATE empresa_llm_settings SET model_id = ? WHERE empresa_id = ?`)
                  .run(targetModel, empresaId);
              }
              return value.apply(statementTarget, params);
            };
          },
        });
      };
    },
  });
}

/**
 * @description Two admins choosing the SAME model is convergence, not conflict.
 *
 * The CAS carries the prior model, so the second save finds a row that no longer matches what it
 * decided against — but the stored value is already exactly what it asked for. Reporting a
 * conflict there would show an error for an operation that, from the operator's view, succeeded.
 */
test("lt-model-cas-converges-on-same-model: an identical concurrent save returns 200", async () => {
  const fixture = await seedFixture("cas-converge");
  const app = createApp(forceConvergentRace(fixture.db, fixture.empresaId, "gpt-5.6-luna"));

  const response = await putSettings(app, fixture.cookie, { model_id: "gpt-5.6-luna" });
  assert.equal(response.status, 200, "an already-converged outcome is not a conflict");
  assert.equal((await response.json()).model_id, "gpt-5.6-luna");
  assert.equal(readSettings(fixture.db, fixture.empresaId).model_id, "gpt-5.6-luna");

  fixture.db.close();
});

/**
 * @description "No provider saved yet" and "model incompatible with the saved provider" are two
 * different states. Collapsing them tells an API caller the wrong thing — the UI blocks this path,
 * the API does not.
 */
test("lt-model-put-without-provider-400-not-configured: a settings-less empresa gets a distinct error", async () => {
  const fixture = await seedFixture("no-provider");
  fixture.db
    .prepare(`DELETE FROM empresa_llm_settings WHERE empresa_id = ?`)
    .run(fixture.empresaId);
  const app = createApp(fixture.db);

  await assertError(
    await putSettings(app, fixture.cookie, { model_id: "gpt-4o-mini" }),
    400,
    "Not configured",
  );
  assert.equal(
    readSettings(fixture.db, fixture.empresaId),
    undefined,
    "no row must be created by a rejected model PUT",
  );

  fixture.db.close();
});
