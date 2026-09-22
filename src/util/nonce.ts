/**
 * Crypto-based random nonce, one per webview load (used by the CSP builder).
 * Pure module: no 'vscode' import.
 */

import { randomBytes } from 'node:crypto';

/**
 * URL-safe base64 nonce (A-Z, a-z, 0-9, '-', '_'; no padding).
 * 32 random bytes by default (256 bits).
 */
export function createNonce(byteLength = 32): string {
  return randomBytes(byteLength)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
