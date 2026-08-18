#!/usr/bin/env node
/**
 * @description Production smoke for the deployed Worker. Four checks: SPA root (200), API auth
 * probe (401), an agent route hit WITHOUT the internal secret header via POST (403), and the agent
 * history READ route via GET /:id (403) — the tenant-data READ surface the internal-secret guard
 * exists to protect. A 403 on the GET history check does NOT distinguish "guard configured" from
 * "secret absent" — the guard fails closed either way. The agent checks are the whole point — a
 * generic HTTP smoke would see the SPA's 200 and call the deploy healthy while the agent routes had
 * actually been swallowed by the ASSETS catch-all (which answers 200 instead of the 403 the guard
 * is supposed to return).
 */
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ name: string, url: string, method: string, expected: number, observed: number | null, passed: boolean }} SmokeCheck
 */

/**
 * @description Runs a single smoke probe and normalizes it into a SmokeCheck, capturing a network
 * failure as observed=null/passed=false instead of throwing.
 * @param {{ name: string, url: string, method: string, expected: number, fetchImpl: typeof fetch }} args
 * @returns {Promise<SmokeCheck>}
 */
async function runCheck({ name, url, method, expected, fetchImpl }) {
  try {
    const response = await fetchImpl(url, { method });
    const observed = response.status;
    return { name, url, method, expected, observed, passed: observed === expected };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ op: 'smokeCheck', name, level: 'error', message }));
    return { name, url, method, expected, observed: null, passed: false };
  }
}

/**
 * @description Runs the production smoke checks against a deployed base URL.
 * @param {{ baseUrl: string, fetchImpl: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, checks: SmokeCheck[] }>}
 */
export async function runSmoke({ baseUrl, fetchImpl }) {
  const base = baseUrl.replace(/\/+$/, '');

  const checks = await Promise.all([
    runCheck({
      name: 'spa-root',
      url: `${base}/`,
      method: 'GET',
      expected: 200,
      fetchImpl,
    }),
    runCheck({
      name: 'auth-me',
      url: `${base}/api/auth/me`,
      method: 'GET',
      expected: 401,
      fetchImpl,
    }),
    runCheck({
      name: 'agent-route-guarded',
      url: `${base}/agents/gestao-bot/smoke-${Date.now()}`,
      method: 'POST',
      expected: 403,
      fetchImpl,
    }),
    runCheck({
      name: 'agent-history-guarded',
      url: `${base}/agents/gestao-bot/smoke-${Date.now()}`,
      method: 'GET',
      expected: 403,
      fetchImpl,
    }),
  ]);

  const ok = checks.every((check) => check.passed);
  return { ok, checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('usage: node scripts/smoke-prod.mjs <baseUrl>');
    process.exit(1);
  }

  runSmoke({ baseUrl, fetchImpl: fetch })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ op: 'runSmoke', level: 'error', message }));
      process.exit(1);
    });
}
