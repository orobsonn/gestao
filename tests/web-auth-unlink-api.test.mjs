/**
 * @description Locked unlinkTelegram client contract — DELETE path, credentials include, 204 success, non-ok throw.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_TELEGRAM_LINK_PATH,
  unlinkTelegram,
} from "../src/react-app/lib/auth-api.ts";

/**
 * @description unlinkTelegram calls fetch with AUTH_TELEGRAM_LINK_PATH, method DELETE, credentials include; 204 empty body resolves undefined; status 500 rejects/throws.
 */
test("lt-ac-8-unlink-telegram-client-contract", async () => {
  assert.equal(AUTH_TELEGRAM_LINK_PATH, "/api/auth/telegram-link");

  const originalFetch = globalThis.fetch;
  /** @type {{ input: unknown, init: RequestInit | undefined }[]} */
  const calls = [];

  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    };

    const result = await unlinkTelegram();
    assert.equal(result, undefined);

    assert.equal(calls.length, 1);
    const { input, init } = calls[0];
    assert.equal(String(input), AUTH_TELEGRAM_LINK_PATH);
    assert.equal(String(input), "/api/auth/telegram-link");
    assert.equal(init?.method, "DELETE");
    assert.equal(init?.credentials, "include");

    calls.length = 0;
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 500 });
    };

    await assert.rejects(() => unlinkTelegram());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
