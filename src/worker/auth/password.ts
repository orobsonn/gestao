/** @description PBKDF2-SHA-256 password hash and timing-safe verify (hex salt/hash). */

import type { PasswordHashResult } from '../types.ts'

const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const DERIVED_BITS = 256
const PASSWORD_MAX_LENGTH = 1024

/**
 * @description Convert bytes to lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @description Parse even-length hex string to bytes; returns null if invalid.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * @description Constant-time equality for equal-length byte arrays.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

/**
 * @description Derive PBKDF2-SHA-256 bits from password and salt bytes.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_BITS,
  )
  return new Uint8Array(bits)
}

/**
 * @description Hash a password with PBKDF2-SHA-256 (100k iters); returns hex hash + hex salt.
 * @throws {TypeError} if password is empty or longer than 1024 characters.
 */
export async function hashPassword(password: string): Promise<PasswordHashResult> {
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    throw new TypeError('password length must be 1..1024')
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const derived = await deriveKey(password, saltBytes)
  return {
    hash: bytesToHex(derived),
    salt: bytesToHex(saltBytes),
  }
}

/**
 * @description Verify password against stored hex hash/salt with timing-safe compare.
 * Returns false for empty/oversize password without running PBKDF2.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    return false
  }
  const saltBytes = hexToBytes(salt)
  const expected = hexToBytes(hash)
  if (!saltBytes || !expected) return false

  const derived = await deriveKey(password, saltBytes)
  return timingSafeEqual(derived, expected)
}
