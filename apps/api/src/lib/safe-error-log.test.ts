import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { safeErrorLogFields } from './safe-error-log';

describe('safeErrorLogFields', () => {
  it('keeps an error type and safe code without serializing message or stack', () => {
    const error = Object.assign(new Error('contains private query, token, and customer data'), { code: 'P2002' });
    const fields = safeErrorLogFields(error);
    assert.deepEqual(fields, { errorType: 'Error', errorCode: 'P2002' });
    assert.doesNotMatch(JSON.stringify(fields), /private query|token|customer/);
  });

  it('uses a fixed diagnostic for non-Error values and rejects unsafe codes', () => {
    assert.deepEqual(safeErrorLogFields('secret value'), { errorType: 'UnknownError' });
    const error = Object.assign(new Error('private'), { code: 'SECRET token' });
    assert.deepEqual(safeErrorLogFields(error), { errorType: 'Error' });
  });
});
