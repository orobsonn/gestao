#!/usr/bin/env node
/**
 * @description Deploy Gestao Worker: Vite SPA client + Flue worker entry.
 *
 * Order matters:
 * 1) `vite build` produces correct Tailwind CSS in dist/client
 * 2) `flue build` produces Flue DO entry in dist/gestao but REWRITES dist/client
 *    with broken unprocessed @apply/@tailwind CSS
 * 3) restore Vite client over Flue's broken client
 * 4) patch rolldown-runtime createRequire (Workers rejects import.meta.url undefined)
 * 5) wrangler deploy --config dist/gestao/wrangler.json
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: false })
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

function patchRolldownRuntime(gestaoDir) {
  const assets = join(gestaoDir, 'assets')
  if (!existsSync(assets)) return false
  const file = readdirSync(assets).find((f) => f.startsWith('rolldown-runtime-') && f.endsWith('.js'))
  if (!file) return false
  const path = join(assets, file)
  const src = readFileSync(path, 'utf8')
  const old =
    'var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();'
  const neu = `var __require = /* #__PURE__ */ (() => {
	try {
		const u = typeof import.meta !== "undefined" ? import.meta.url : undefined;
		if (typeof u === "string" && u.length > 0) return createRequire(u);
	} catch {}
	return (id) => { throw new Error("[workers] require unavailable: " + String(id)); };
})();`
  if (src.includes('[workers] require unavailable')) {
    console.log(`[deploy] rolldown runtime already patched (${file})`)
    return true
  }
  if (!src.includes(old)) {
    console.warn(`[deploy] WARN: createRequire pattern not found in ${file}`)
    return false
  }
  writeFileSync(path, src.replace(old, neu))
  console.log(`[deploy] patched ${file}`)
  return true
}

const clientDir = join(root, 'dist/client')
const gestaoDir = join(root, 'dist/gestao')
const stash = mkdtempSync(join(tmpdir(), 'gestao-client-'))

console.log('[deploy] 1/5 vite build (good Tailwind client)')
run('npx', ['vite', 'build'])
if (!existsSync(clientDir)) {
  console.error('[deploy] dist/client missing after vite build')
  process.exit(1)
}
cpSync(clientDir, stash, { recursive: true })

console.log('[deploy] 2/5 flue build (Flue worker + DO classes)')
run('npx', ['flue', 'build', '--target', 'cloudflare'])

console.log('[deploy] 3/5 restore Vite client (flue overwrites CSS)')
if (existsSync(clientDir)) {
  rmSync(clientDir, { recursive: true, force: true })
}
mkdirSync(clientDir, { recursive: true })
cpSync(stash, clientDir, { recursive: true })
rmSync(stash, { recursive: true, force: true })

console.log('[deploy] 4/5 patch Workers createRequire')
patchRolldownRuntime(gestaoDir)

console.log('[deploy] 5/5 wrangler deploy')
run('npx', ['wrangler', 'deploy', '--config', 'dist/gestao/wrangler.json'])
console.log('[deploy] done')
