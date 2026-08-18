import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bindTurnTokenToAgent,
  consumeAgentBoundTurn,
  insertTurnContext,
} from "../src/worker/agent/turn-context-store.ts";
import { handleBotTurn } from "../src/worker/services/bot-turn-orchestrator.ts";
import {
  encryptLlmApiKey,
} from "../src/worker/services/llm-key-crypto.ts";
import gestaoBotDefinition, {
  route as gestaoBotRoute,
} from "../.flue/agents/gestao-bot.ts";
import { hasRegisteredProvider, resolveModel } from "@flue/runtime/internal";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(TEST_DIR, "../migrations");
const ENCRYPTION_SECRET = "test-bot-turn-model-context-secret";
const BOT_USERNAME = "GestaoBot";

/**
 * @description Asserts the agent config resolves the expected model under a TURN-SCOPED provider.
 *
 * The specifier is `<provider>--<sanitized agent id>/<native model>`: the provider half must never
 * be the bare canonical id, because Flue's registry is module-scoped and last-write-wins, so a
 * shared id lets a sibling Durable Object swap this turn's API key mid-flight.
 */
function assertTurnModel(config, { provider, nativeModel, empresaId }) {
  const [providerId, ...rest] = String(config.model).split("/");
  assert.equal(rest.join("/"), nativeModel, "native model must round-trip");
  assert.notEqual(providerId, provider, "provider id must not be the shared canonical id");
  assert.ok(
    providerId.startsWith(`${provider}--`),
    `provider id ${providerId} must be scoped to this turn's provider`,
  );
  const encoded = Array.from(new TextEncoder().encode(empresaId))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  assert.ok(
    providerId.includes(encoded),
    `provider id ${providerId} must be scoped to this empresa`,
  );
}

/** @description Opens an in-memory database with foreign keys and the complete lexical migration chain. */
function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, migration), "utf8"));
  }
  return db;
}

/** @description Seeds a user, empresa membership, Telegram link, and valid model-specific LLM settings. */
async function seedActorAndSettings(db, { userId, telegramId, empresaId, provider, modelId }) {
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, 'hash', 'salt', 'user')`,
  ).run(userId, `${userId}@example.com`, `User ${userId}`);
  db.prepare("INSERT INTO empresas (id, nome) VALUES (?, ?)").run(
    empresaId,
    `Empresa ${empresaId}`,
  );
  db.prepare(
    `INSERT INTO empresa_membros (id, empresa_id, user_id, papel)
     VALUES (?, ?, ?, 'membro')`,
  ).run(`member-${userId}`, empresaId, userId);
  db.prepare(
    `INSERT INTO user_telegram_links (user_id, telegram_user_id, linked_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(userId, telegramId);

  const { ciphertextHex, ivHex } = await encryptLlmApiKey(
    ENCRYPTION_SECRET,
    `key-${provider}-${empresaId}`,
  );
  db.prepare(
    `INSERT INTO empresa_llm_settings
       (empresa_id, provider, model_id, api_key_ciphertext, api_key_iv, status)
     VALUES (?, ?, ?, ?, ?, 'valid')`,
  ).run(empresaId, provider, modelId, ciphertextHex, ivHex);
}

/** @description Builds a private Telegram update for a linked DM actor. */
function dmUpdate(telegramId) {
  return {
    message: {
      from: { id: telegramId },
      chat: { id: telegramId, type: "private" },
      text: "resuma minhas tarefas",
    },
  };
}

/** @description Builds a Telegram topic update containing an exact bot mention entity. */
function topicUpdate(telegramId, chatId, threadId) {
  const mention = `@${BOT_USERNAME}`;
  return {
    message: {
      from: { id: telegramId },
      chat: { id: chatId, type: "supergroup" },
      message_thread_id: threadId,
      text: `${mention} resuma as tarefas`,
      entities: [{ type: "mention", offset: 0, length: mention.length }],
    },
  };
}


/** @description Persists a DM turn with configured OpenAI settings and consumes its exact model context. */
test("lt-dm-model-context-roundtrip: OpenAI model survives the DM one-shot context", async () => {
  const db = openDb();
  const userId = "user-model-dm";
  const telegramId = "710001";
  const empresaId = "empresa-model-dm";
  await seedActorAndSettings(db, {
    userId,
    telegramId,
    empresaId,
    provider: "openai",
    modelId: "gpt-5.6-terra",
  });

  // Exercise the REAL admission pair (bind + consumeAgentBoundTurn) from inside the turn, while
  // the row still exists — reading the raw token afterwards would go through a path production
  // never takes, and the orchestrator has released the row by then anyway.
  let consumed = { ok: false };
  await handleBotTurn({
    db,
    update: dmUpdate(telegramId),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: ENCRYPTION_SECRET,
    runAgentTurn: async ({ sessionId, turnToken: token }) => {
      assert.equal(await bindTurnTokenToAgent(db, token, sessionId), true);
      consumed = await consumeAgentBoundTurn(db, sessionId, ENCRYPTION_SECRET);
      return "ok";
    },
  });

  assert.equal(consumed.ok, true);
  assert.equal(consumed.surface, "dm");
  assert.equal(consumed.empresa_id, empresaId);
  assert.equal(consumed.model_id, "openai/gpt-5.6-terra");
  db.close();
});

/** @description Persists a topic turn with configured Anthropic settings and consumes its exact bound model context. */
test("lt-topic-model-context-roundtrip: Anthropic model survives the topic one-shot context", async () => {
  const db = openDb();
  const userId = "user-model-topic";
  const telegramId = "710002";
  const empresaId = "empresa-model-topic";
  const expertId = "expert-model-topic";
  const chatId = "-100710002";
  const threadId = "52";
  await seedActorAndSettings(db, {
    userId,
    telegramId,
    empresaId,
    provider: "anthropic",
    modelId: "claude-opus-4-8",
  });
  db.prepare(
    "INSERT INTO experts (id, empresa_id, nome) VALUES (?, ?, 'Expert Topic')",
  ).run(expertId, empresaId);
  db.prepare(
    "INSERT INTO empresa_telegram_chats (empresa_id, chat_id) VALUES (?, ?)",
  ).run(empresaId, chatId);
  db.prepare(
    `INSERT INTO expert_telegram_topics
       (expert_id, empresa_id, chat_id, message_thread_id)
     VALUES (?, ?, ?, ?)`,
  ).run(expertId, empresaId, chatId, threadId);

  // Same as the DM case: consume through the real admission pair, inside the turn.
  let consumed = { ok: false };
  await handleBotTurn({
    db,
    update: topicUpdate(telegramId, chatId, threadId),
    botUsername: BOT_USERNAME,
    llmKeyEncryptionSecret: ENCRYPTION_SECRET,
    runAgentTurn: async ({ sessionId, turnToken: token }) => {
      assert.equal(await bindTurnTokenToAgent(db, token, sessionId), true);
      consumed = await consumeAgentBoundTurn(db, sessionId, ENCRYPTION_SECRET);
      return "ok";
    },
  });

  assert.equal(consumed.ok, true);
  assert.equal(consumed.surface, "topic");
  assert.equal(consumed.empresa_id, empresaId);
  assert.equal(consumed.expert_id, expertId);
  assert.equal(consumed.model_id, "anthropic/claude-opus-4-8");
  db.close();
});






/**
 * @description Two empresas on the SAME provider must never share a credential slot.
 *
 * Flue's provider registry is module-scoped and last-write-wins, and the API key is resolved
 * lazily on every model call — not captured at init. With the bare `openai` id, a sibling Durable
 * Object registering its own key mid-turn would make the first turn's next call go out on the
 * second empresa's account. Each turn therefore registers under its own provider id, and this
 * pins that both remain independently resolvable with real metadata.
 */
test("lt-turn-provider-isolated-across-agents: distinct empresas keep distinct credential slots", async () => {
  const db = openDb();

  const turns = [
    {
      agentId: "dm:iso-a",
      empresaId: "empresa-iso-a",
      userId: "user-iso-a",
      telegramId: "770001",
      provider: "openai",
      modelId: "gpt-5.6-sol",
      apiKey: "key-openai-iso-a",
    },
    {
      agentId: "dm:iso-b",
      empresaId: "empresa-iso-b",
      userId: "user-iso-b",
      telegramId: "770002",
      provider: "openai",
      modelId: "gpt-5.6-terra",
      apiKey: "key-openai-iso-b",
    },
  ];

  const env = {
    DB: db,
    GESTAO_AGENT_INTERNAL_SECRET: "test-internal-agent-secret",
    LLM_KEY_ENCRYPTION_SECRET: ENCRYPTION_SECRET,
  };

  for (const turn of turns) {
    await seedActorAndSettings(db, turn);
    const inserted = await insertTurnContext(db, {
      empresaId: turn.empresaId,
      expertId: null,
      actorUserId: turn.userId,
      surface: "dm",
      provider: turn.provider,
      modelId: `openai/${turn.modelId}`,
      apiKey: turn.apiKey,
      message: `turn for ${turn.userId}`,
      encryptionSecret: ENCRYPTION_SECRET,
    });
    assert.ok(inserted);
    assert.equal(await bindTurnTokenToAgent(db, inserted.turn_token, turn.agentId), true);
    // Interleaved: B initializes while A's turn is still notionally in flight.
    turn.config = await gestaoBotDefinition.initialize({ id: turn.agentId, env });
  }

  const [a, b] = turns;
  // Each turn must resolve its OWN native model, not just its own provider slot — this is the
  // observable that #ac-model.1 turns on, all the way through Flue's initializer.
  for (const turn of turns) {
    assertTurnModel(turn.config, {
      provider: turn.provider,
      nativeModel: turn.modelId,
      empresaId: turn.empresaId,
    });
  }
  const providerA = String(a.config.model).split("/")[0];
  const providerB = String(b.config.model).split("/")[0];
  assert.notEqual(providerA, providerB, "each agent must own a distinct provider slot");
  for (const [label, providerId] of [["A", providerA], ["B", providerB]]) {
    assert.notEqual(
      providerId,
      "openai",
      `${label} must not use the shared canonical provider id`,
    );
  }

  // A later init of A — after B has registered — must still address A's own slot and identity.
  const reinitA = await gestaoBotDefinition.initialize({ id: a.agentId, env });
  assert.equal(
    String(reinitA.model).split("/")[0],
    providerA,
    "a sibling registration must not move A onto another slot",
  );
  assert.match(reinitA.instructions, new RegExp(a.empresaId));
  assert.doesNotMatch(reinitA.instructions, new RegExp(b.empresaId));

  db.close();
});




/**
 * @description Two empresas reached through the SAME agent id must not share a credential slot.
 *
 * A DM's agent id is `dm:<userId>` — agnostic of empresa. A user who belongs to two empresas hits
 * the same agent id for both, so scoping the provider slot by AGENT collapses the two credentials
 * into one entry. Flue's registry is last-write-wins and resolves the key lazily per model call,
 * so an in-flight turn for empresa A would start billing empresa B. The tenancy boundary is the
 * empresa, not the agent.
 */
test("lt-turn-provider-isolated-per-empresa: one agent id, two empresas, two credential slots", async () => {
  const db = openDb();
  const agentId = "dm:shared-user";
  const userId = "user-shared";
  const env = {
    DB: db,
    GESTAO_AGENT_INTERNAL_SECRET: "test-internal-agent-secret",
    LLM_KEY_ENCRYPTION_SECRET: ENCRYPTION_SECRET,
  };

  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role)
     VALUES (?, ?, ?, 'hash', 'salt', 'user')`,
  ).run(userId, `${userId}@example.com`, "Shared User");

  const empresas = [
    { empresaId: "empresa-shared-a", modelId: "gpt-5.6-sol", apiKey: "key-a" },
    { empresaId: "empresa-shared-b", modelId: "gpt-5.6-terra", apiKey: "key-b" },
  ];
  for (const e of empresas) {
    db.prepare("INSERT INTO empresas (id, nome) VALUES (?, ?)").run(e.empresaId, e.empresaId);
    db.prepare(
      `INSERT INTO empresa_membros (id, empresa_id, user_id, papel) VALUES (?, ?, ?, 'membro')`,
    ).run(`m-${e.empresaId}`, e.empresaId, userId);
    const enc = await encryptLlmApiKey(ENCRYPTION_SECRET, e.apiKey);
    db.prepare(
      `INSERT INTO empresa_llm_settings
         (empresa_id, provider, model_id, api_key_ciphertext, api_key_iv, status)
       VALUES (?, 'openai', ?, ?, ?, 'valid')`,
    ).run(e.empresaId, e.modelId, enc.ciphertextHex, enc.ivHex);

    const inserted = await insertTurnContext(db, {
      empresaId: e.empresaId,
      expertId: null,
      actorUserId: userId,
      surface: "dm",
      provider: "openai",
      modelId: `openai/${e.modelId}`,
      apiKey: e.apiKey,
      message: `turn for ${e.empresaId}`,
      encryptionSecret: ENCRYPTION_SECRET,
    });
    assert.ok(inserted);
    assert.equal(await bindTurnTokenToAgent(db, inserted.turn_token, agentId), true);
    e.config = await gestaoBotDefinition.initialize({ id: agentId, env });
  }

  const [a, b] = empresas;
  const slotA = String(a.config.model).split("/")[0];
  const slotB = String(b.config.model).split("/")[0];
  assert.notEqual(
    slotA,
    slotB,
    "two empresas reached through one agent id must not collapse onto one credential slot",
  );
  assert.notEqual(slotA, "openai", "the shared canonical id must never be used");

  // Observe the REGISTRY, not just the specifier: comparing strings alone would stay green even
  // if registerProvider were deleted, because the model string is built independently of it.
  for (const [label, e] of [["A", a], ["B", b]]) {
    const slot = String(e.config.model).split("/")[0];
    assert.equal(
      hasRegisteredProvider(slot),
      true,
      `${label}'s credential slot must actually be registered`,
    );
    const resolved = resolveModel(e.config.model);
    assert.equal(resolved.provider, slot, `${label} must resolve through its own slot`);
    assert.ok(Number(resolved.maxTokens) > 0, `${label} must resolve with real metadata`);
  }

  db.close();
});
