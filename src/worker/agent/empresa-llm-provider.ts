/**
 * @description SCAFFOLD STUB — the per-empresa LLM credential slot.
 *
 * Not implemented yet. Both exports throw so the frozen locked test COLLECTS (a non-vacuous gate)
 * while staying legitimately RED until the real implementation lands.
 */

/** @description Derived provider id so one empresa's key can never overwrite another's slot. */
export function buildEmpresaProviderId(
  _provider: string,
  _empresaId: string,
  _nativeModelId: string,
): string {
  throw new Error('not implemented')
}

export interface CreateEmpresaProviderInput {
  provider: 'openai' | 'anthropic'
  empresaId: string
  nativeModelId: string
  resolveApiKey: () => Promise<string>
}

/** @description Pi provider whose credential is reachable only through the async auth resolver. */
export function createEmpresaProvider(_input: CreateEmpresaProviderInput): unknown {
  throw new Error('not implemented')
}
