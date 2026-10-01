import { describe, expect, it, vi } from 'vitest';
import { ConfiguredSmsProvider } from '../sms-provider';

describe('SMS provider', () => {
  it('does not make an external request while the feature is disabled', async () => {
    const fetcher = vi.fn();
    const provider = new ConfiguredSmsProvider({
      isEnabled: () => false,
      endpoint: 'https://sms.example/send',
      token: 'test-token',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(provider.send('+998901234567', 'Verification message')).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
