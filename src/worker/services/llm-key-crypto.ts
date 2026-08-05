/** @description AES-256-GCM encrypt/decrypt for per-tenant LLM API keys at rest. */

const IV_BYTES = 12
const AES_ALGORITHM = 'AES-GCM'

/**
 * @description Convert bytes to lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @description Parse even-length hex string to bytes; throws if invalid.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new TypeError('invalid hex encoding')
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError('invalid hex encoding')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * @description Reject empty or whitespace-only encryption secrets (fail closed).
 */
function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new TypeError('LLM_KEY_ENCRYPTION_SECRET is required')
  }
}

/**
 * @description Derive a 256-bit AES-GCM CryptoKey from SHA-256(UTF-8 secret).
 */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret)
  const digest = await crypto.subtle.digest('SHA-256', secretBytes)
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: AES_ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * @description Encrypt a plaintext LLM API key with AES-256-GCM.
 * Key material is SHA-256 of the UTF-8 secret; IV is 12 random bytes per call.
 * Returns lowercase hex ciphertext and iv. Never logs plaintext.
 * @throws {TypeError} if secret is empty or whitespace-only.
 */
export async function encryptLlmApiKey(
  secret: string,
  plaintext: string,
): Promise<{ ciphertextHex: string; ivHex: string }> {
  assertSecret(secret)

  const key = await deriveAesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintextBytes = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv },
    key,
    plaintextBytes,
  )

  return {
    ciphertextHex: bytesToHex(new Uint8Array(ciphertext)),
    ivHex: bytesToHex(iv),
  }
}

/**
 * @description Decrypt an LLM API key ciphertext produced by encryptLlmApiKey.
 * Wrong secret or tampered ciphertext fails closed (throws); never returns plaintext on failure.
 * Never logs plaintext.
 * @throws {TypeError} if secret is empty or whitespace-only, or hex is invalid.
 * @throws {DOMException} if authentication fails (wrong key / tampered data).
 */
export async function decryptLlmApiKey(
  secret: string,
  ciphertextHex: string,
  ivHex: string,
): Promise<string> {
  assertSecret(secret)

  const key = await deriveAesKey(secret)
  const iv = hexToBytes(ivHex)
  const ciphertext = hexToBytes(ciphertextHex)

  const plaintextBytes = await crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  )

  return new TextDecoder().decode(plaintextBytes)
}
