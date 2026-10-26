import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIncomingMessage,
  validateKeyRequirement,
  calculateBackoffDelay,
  evaluateWatchdogAction,
  getBitrateProfile,
  MAX_MESSAGE_SIZE_BYTES,
} from './signalingRules';

test('validateIncomingMessage rejects non-JSON and missing type', () => {
  const nonJson = validateIncomingMessage('not valid json');
  assert.equal(nonJson.valid, false);

  const missingType = validateIncomingMessage('{"foo": "bar"}');
  assert.equal(missingType.valid, false);

  const valid = validateIncomingMessage('{"type": "ping"}');
  assert.equal(valid.valid, true);
  assert.equal(valid.parsed?.type, 'ping');
});

test('validateIncomingMessage rejects payload over 64 KB limit', () => {
  const hugePayload = JSON.stringify({ type: 'huge', data: 'x'.repeat(MAX_MESSAGE_SIZE_BYTES + 10) });
  const result = validateIncomingMessage(hugePayload);
  assert.equal(result.valid, false);
  assert.match(result.reason || '', /exceeds limit/);
});

test('validateKeyRequirement enforces 32-character minimum', () => {
  assert.equal(validateKeyRequirement('short-key').valid, false);
  assert.equal(validateKeyRequirement('1234567890123456789012345678901').valid, false); // 31 chars
  assert.equal(validateKeyRequirement('12345678901234567890123456789012').valid, true); // 32 chars
  assert.equal(validateKeyRequirement('abcdef0123456789abcdef0123456789abcdef0123456789').valid, true);
});

test('calculateBackoffDelay produces exponential delays capped at 30s', () => {
  assert.equal(calculateBackoffDelay(1), 1000);
  assert.equal(calculateBackoffDelay(2), 2000);
  assert.equal(calculateBackoffDelay(3), 4000);
  assert.equal(calculateBackoffDelay(4), 8000);
  assert.equal(calculateBackoffDelay(5), 16000);
  assert.equal(calculateBackoffDelay(6), 30000); // capped at 30s
  assert.equal(calculateBackoffDelay(10), 30000);
});

test('evaluateWatchdogAction triggers correct escalation stages', () => {
  // Normal state
  assert.equal(evaluateWatchdogAction(0, 0), 'none');
  assert.equal(evaluateWatchdogAction(6, 0), 'none');

  // Stage 1: Stuck for 8s -> ICE restart
  assert.equal(evaluateWatchdogAction(8, 0), 'ice_restart');
  assert.equal(evaluateWatchdogAction(14, 0), 'ice_restart');

  // Stage 2: Stuck for 18s -> Rebuild connection
  assert.equal(evaluateWatchdogAction(18, 0), 'rebuild_connection');
  assert.equal(evaluateWatchdogAction(25, 0), 'rebuild_connection');

  // Stage 3: 3 consecutive failures -> Backoff cooldown
  assert.equal(evaluateWatchdogAction(0, 3), 'backoff_cooldown');
  assert.equal(evaluateWatchdogAction(20, 3), 'backoff_cooldown');
});

test('getBitrateProfile returns exact specifications from spec', () => {
  const autoProfile = getBitrateProfile('auto');
  assert.equal(autoProfile.maxBitrate, 800_000);
  assert.equal(autoProfile.maxFramerate, 15);

  const highProfile = getBitrateProfile('high');
  assert.equal(highProfile.maxBitrate, 2_000_000);
  assert.equal(highProfile.maxFramerate, 30);
});
