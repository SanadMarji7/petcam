/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SignalingMessage {
  type: string;
  key?: string;
  id?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  viewer_id?: string;
  quality?: 'auto' | 'high';
  reason?: string;
}

export const MAX_MESSAGE_SIZE_BYTES = 64 * 1024; // 64 KB limit
export const HEARTBEAT_TIMEOUT_SECONDS = 30;
export const WATCHDOG_RESTART_THRESHOLD_SECONDS = 8;
export const WATCHDOG_REBUILD_THRESHOLD_SECONDS = 18;
export const WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3;
export const WATCHDOG_BACKOFF_SECONDS = 30;

/**
 * Validates whether an incoming message string is valid JSON and within 64 KB limit
 */
export function validateIncomingMessage(rawPayload: string): { valid: boolean; reason?: string; parsed?: SignalingMessage } {
  const byteLength = new TextEncoder().encode(rawPayload).length;
  if (byteLength > MAX_MESSAGE_SIZE_BYTES) {
    return { valid: false, reason: `Payload size (${byteLength} bytes) exceeds limit of ${MAX_MESSAGE_SIZE_BYTES} bytes` };
  }

  try {
    const parsed = JSON.parse(rawPayload);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return { valid: false, reason: 'Message must be an object with a string "type" field' };
    }
    return { valid: true, parsed };
  } catch (err: any) {
    return { valid: false, reason: `Invalid JSON: ${err.message}` };
  }
}

/**
 * Validates key length requirements (must be at least 32 characters)
 */
export function validateKeyRequirement(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Key cannot be empty' };
  }
  if (key.trim().length < 32) {
    return { valid: false, error: `Key must be at least 32 characters (got ${key.trim().length})` };
  }
  return { valid: true };
}

/**
 * Calculates exponential backoff delay in milliseconds
 * Formula: min(30000, 2^(attempt - 1) * 1000)
 */
export function calculateBackoffDelay(attempt: number, maxDelayMs = 30000): number {
  if (attempt <= 0) return 1000;
  const base = Math.pow(2, attempt - 1) * 1000;
  return Math.min(maxDelayMs, base);
}

/**
 * Evaluates watchdog action based on stuck frame duration and consecutive failure count
 */
export function evaluateWatchdogAction(
  stuckSeconds: number,
  consecutiveFailures: number
): 'none' | 'ice_restart' | 'rebuild_connection' | 'backoff_cooldown' {
  if (consecutiveFailures >= WATCHDOG_MAX_CONSECUTIVE_FAILURES) {
    return 'backoff_cooldown';
  }
  if (stuckSeconds >= WATCHDOG_REBUILD_THRESHOLD_SECONDS) {
    return 'rebuild_connection';
  }
  if (stuckSeconds >= WATCHDOG_RESTART_THRESHOLD_SECONDS) {
    return 'ice_restart';
  }
  return 'none';
}

/**
 * Formats video resolution and bitrate specs for UI
 */
export function getBitrateProfile(mode: 'auto' | 'high'): { maxBitrate: number; maxFramerate: number; label: string } {
  if (mode === 'high') {
    return {
      maxBitrate: 2_000_000,
      maxFramerate: 30,
      label: 'High (2 Mbps, 30 fps)',
    };
  }
  return {
    maxBitrate: 800_000,
    maxFramerate: 15,
    label: 'Auto (800 kbps, 15 fps)',
  };
}

/**
 * Extracts authentication key from URL hash fragment (e.g. #key=secret_value or #secret_value)
 * Never transmitted to server; purely client-side extracted
 */
export function extractKeyFromFragment(hash: string): string | null {
  if (!hash) return null;
  const cleaned = hash.startsWith('#') ? hash.substring(1) : hash;
  if (!cleaned) return null;

  // Case 1: Standard param format #key=...
  if (cleaned.includes('=')) {
    const params = new URLSearchParams(cleaned);
    const keyVal = params.get('key');
    if (keyVal && keyVal.trim().length >= 32) {
      return keyVal.trim();
    }
  }

  // Case 2: Bare token #<32-char-token>
  if (cleaned.length >= 32 && !cleaned.includes('&')) {
    return cleaned.trim();
  }

  return null;
}

/**
 * Builds secure pairing URL with fragment-encoded key
 */
export function buildPairingUrl(baseUrl: string, role: 'cam' | 'watch', key: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const path = role === 'cam' ? '/cam' : '/watch';
  return `${cleanBase}${path}#key=${encodeURIComponent(key)}`;
}
