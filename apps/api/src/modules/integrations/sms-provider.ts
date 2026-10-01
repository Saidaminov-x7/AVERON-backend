import { config } from '../../config';
import { featureFlags } from '../features/feature-flags';
import type { SmsProvider } from './contracts';

type SmsProviderOptions = {
  isEnabled: () => boolean;
  endpoint?: string;
  token?: string;
  sender?: string;
  fetcher?: typeof fetch;
};

export class ConfiguredSmsProvider implements SmsProvider {
  constructor(private readonly options: SmsProviderOptions = {
    isEnabled: () => featureFlags.isEnabled('SMS_VERIFICATION'),
    endpoint: config.SMS_API_URL,
    token: config.SMS_API_TOKEN,
    sender: config.SMS_SENDER,
  }) {}

  async send(phone: string, message: string): Promise<boolean> {
    if (!this.options.isEnabled()) return false;
    const endpoint = this.options.endpoint;
    const token = this.options.token?.trim();
    if (!endpoint || !token) return false;

    const response = await (this.options.fetcher ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ mobile_phone: phone, message, from: this.options.sender?.trim() || 'AVERON' }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  }
}

export const smsProvider: SmsProvider = new ConfiguredSmsProvider();
