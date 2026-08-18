#!/usr/bin/env node
/**
 * @description Post-build fixup for `dist/gestao/wrangler.json`.
 *
 * `@cloudflare/vite-plugin` unconditionally rewrites every `d1_databases[].migrations_dir` to be
 * relative to the WORKER OUTPUT directory (`dist/gestao`) instead of passing it through unchanged
 * — so the authored `wrangler.jsonc` value `"migrations"` (root-relative) becomes
 * `"../../migrations"` in the generated file. That rewrite is functionally inert here: nothing in
 * this repo ever runs `wrangler d1 migrations …` against the GENERATED config — `db:migrate` /
 * `db:migrate:local` always target the authored root `wrangler.jsonc` — so restoring the authored
 * `d1_databases` array verbatim after the build is safe and keeps the generated artifact an exact
 * pass-through of the authored D1 binding, as `wrangler deploy` itself never reads `migrations_dir`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const AUTHORED_WRANGLER_JSONC_PATH = resolve(ROOT, 'wrangler.jsonc');
const GENERATED_WRANGLER_JSON_PATH = resolve(ROOT, 'dist/gestao/wrangler.json');

/**
 * @description Strip // and block comments from JSONC so JSON.parse can read wrangler.jsonc.
 */
function parseJsonc(raw) {
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped);
}

/**
 * @description Restores the generated wrangler.json's d1_databases array to be byte-identical to
 * the authored wrangler.jsonc's d1_databases array, undoing the plugin's migrations_dir rewrite.
 */
export function fixGeneratedWranglerD1() {
  if (!existsSync(GENERATED_WRANGLER_JSON_PATH)) {
    throw new Error(`generated wrangler.json not found at ${GENERATED_WRANGLER_JSON_PATH} — run vite build first`);
  }

  const authored = parseJsonc(readFileSync(AUTHORED_WRANGLER_JSONC_PATH, 'utf8'));
  const generated = JSON.parse(readFileSync(GENERATED_WRANGLER_JSON_PATH, 'utf8'));

  generated.d1_databases = authored.d1_databases;

  writeFileSync(GENERATED_WRANGLER_JSON_PATH, JSON.stringify(generated));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fixGeneratedWranglerD1();
}
