import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { loginFailureKey } from './login-throttle';

describe('temporary login throttles', () => {
  it('scopes an account lockout to both normalized identity and source IP', () => {
    const accountAFromIpA = loginFailureKey('email', 'Person@Example.com', '203.0.113.10');
    assert.equal(accountAFromIpA, loginFailureKey('email', ' person@example.com ', '203.0.113.10'));
    assert.notEqual(accountAFromIpA, loginFailureKey('email', 'person@example.com', '203.0.113.11'));
    assert.notEqual(accountAFromIpA, loginFailureKey('phone', 'person@example.com', '203.0.113.10'));
    assert.doesNotMatch(accountAFromIpA, /person|203\.0\.113/);
  });
});
