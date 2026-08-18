/**
 * @description Stubs the `cloudflare:workers` module so a Flue 2.x agent module —
 * which must statically `import { env } from 'cloudflare:workers'` — can be imported
 * under plain `node --test`. Without this hook, that static import fails with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME because Node has no `cloudflare:` URL scheme outside
 * the Workers runtime. Registers a `node:module` resolve hook that short-circuits any
 * `cloudflare:workers` specifier to an empty in-memory module exporting `env = {}`.
 * Idempotent — calling it more than once installs the hook only once, so multiple test
 * files that each import this helper never double-register it.
 */
import module from "node:module";

let registered = false;

export function registerCloudflareWorkersStub() {
  if (registered) return;
  registered = true;
  module.registerHooks({
    resolve(spec, ctx, next) {
      if (spec === "cloudflare:workers") {
        return {
          url: "data:text/javascript,export const env = {};",
          shortCircuit: true,
        };
      }
      return next(spec, ctx);
    },
  });
}
