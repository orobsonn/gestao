/**
 * @description Per-empresa LLM credential slot.
 *
 * Flue's provider registry is module/isolate-scoped, keyed by `provider.id`,
 * last-write-wins, with no unregister. Registering an empresa's key under the
 * canonical 'openai'/'anthropic' id lets a sibling Durable Object in the same
 * isolate overwrite the slot mid-turn and the in-flight turn starts billing
 * another empresa. `buildEmpresaProviderId` derives a per-(empresa, model) id
 * so two empresas never collide; `createEmpresaProvider` wires the API key ONLY
 * through the async `auth.apiKey.resolve` callback, never as a plain field, so
 * it never leaks into a serialised structure and the synchronous agent render
 * stays legal (the D1 read + AES decrypt happens lazily at model-call time,
 * between renders).
 *
 * Pure module: no side effects at import time, no `setProvider` call (registration
 * happens in the agent module), and no `cloudflare:` import — it must stay
 * importable under `node --experimental-strip-types --test`. The empresa's key
 * arrives as the injected `resolveApiKey` callback; this module never reads env,
 * never touches D1, and never decrypts anything itself.
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type { AuthResult, ApiKeyCredential } from '@earendil-works/pi-ai'
import type { Provider, Model, Api } from '@earendil-works/pi-ai'

/** Shared UTF-8 encoder for the id derivation. */
const utf8Encoder = new TextEncoder()

/**
 * @description Lowercase hex of a string's UTF-8 bytes. Hex (not the raw value)
 * keeps the derivation injective and guarantees the id can never contain a '/',
 * the model-specifier separator.
 */
function hexOfUtf8(value: string): string {
  const bytes = utf8Encoder.encode(value)
  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/**
 * @description Derived provider id `<provider>--<hex(empresaId)>--<hex(nativeModelId)>`
 * so one empresa's key can never overwrite another's registry slot. Never equals
 * the canonical provider id and never contains a '/'.
 * @param provider - canonical provider family ('openai' | 'anthropic')
 * @param empresaId - tenant identifier
 * @param nativeModelId - the provider's native model id (e.g. 'gpt-4o-mini')
 * @returns the empresa-scoped provider id
 */
export function buildEmpresaProviderId(
  provider: string,
  empresaId: string,
  nativeModelId: string,
): string {
  return `${provider}--${hexOfUtf8(empresaId)}--${hexOfUtf8(nativeModelId)}`
}

export interface CreateEmpresaProviderInput {
  provider: 'openai' | 'anthropic'
  empresaId: string
  nativeModelId: string
  /** Lazily yields the plaintext API key, called only at model-call time. */
  resolveApiKey: () => Promise<string>
}

/**
 * @description Builds a pi-ai provider whose credential is reachable ONLY
 * through the async `auth.apiKey.resolve` callback. The model catalog comes
 * from the BUILT-IN provider catalogs (full Model objects — real cost,
 * contextWindow, maxTokens, compat, thinkingLevelMap), remapped so each entry
 * carries the derived empresa-scoped provider id. This is what kills the beta's
 * getModel()-from-pi-ai/compat zero-fill hack that shipped max_tokens: 0.
 * @param input - empresa/provider/model triple plus the lazy key resolver
 * @returns a pi-ai Provider whose auth.apiKey.resolve yields the empresa's key
 */
export function createEmpresaProvider(
  input: CreateEmpresaProviderInput,
): Provider<Api> {
  const { provider, empresaId, nativeModelId, resolveApiKey } = input
  const derivedId = buildEmpresaProviderId(provider, empresaId, nativeModelId)

  const base = provider === 'openai' ? openaiProvider() : anthropicProvider()
  const models = base.getModels().map(
    (model): Model<Api> => ({ ...model, provider: derivedId }),
  )
  const api = provider === 'openai' ? openAIResponsesApi() : anthropicMessagesApi()

  return createProvider({
    id: derivedId,
    name: base.name,
    auth: {
      apiKey: {
        name: `${base.name} (empresa ${empresaId})`,
        resolve: async (
          _input: { ctx: unknown; credential?: ApiKeyCredential | undefined },
        ): Promise<AuthResult | undefined> => {
          const apiKey = await resolveApiKey()
          if (apiKey === undefined || apiKey === '') return undefined
          return { auth: { apiKey } }
        },
      },
    },
    models,
    api,
  })
}