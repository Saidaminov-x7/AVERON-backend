import { createHash } from 'node:crypto';

const DENIAL_WINDOW_SECONDS = 5 * 60;
const DENIAL_ALERT_THRESHOLD = 12;
const ALERT_DEDUP_SECONDS = 60 * 60;
const ALERT_RETRY_COOLDOWN_SECONDS = 60;

const incrementWindowScript = [
  "local count = redis.call('INCR', KEYS[1]);",
  "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end;",
  'return count',
].join(' ');

type SecurityDenialDependencies = {
  redis: {
    eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
    set(key: string, value: string, expiryMode: 'EX', seconds: number, condition: 'NX'): Promise<'OK' | null>;
    expire(key: string, seconds: number): Promise<number>;
  };
  createAdminNotification: (data: {
    type: string;
    title: string;
    message: string;
    link: string;
  }) => Promise<unknown>;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
};

export async function monitorAuthenticatedAuthorizationDenial(
  dependencies: SecurityDenialDependencies,
  input: { userId?: string | null; route?: string; statusCode: number },
): Promise<void> {
  if (input.statusCode !== 403 || !input.userId) return;

  const actorHash = createHash('sha256').update(input.userId).digest('hex');
  const counterKey = `averon:v1:security:denials:${actorHash}`;
  const alertKey = `averon:v1:security:denials-alert:${actorHash}`;

  try {
    const count = Number(await dependencies.redis.eval(
      incrementWindowScript,
      1,
      counterKey,
      String(DENIAL_WINDOW_SECONDS),
    ));
    if (!Number.isFinite(count) || count < DENIAL_ALERT_THRESHOLD) return;

    const claimed = await dependencies.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;

    const actorLabel = actorHash.slice(0, 12);
    dependencies.warn({
      actorHash: actorLabel,
      route: input.route ?? 'unmatched',
      statusCode: input.statusCode,
      deniedRequests: count,
      windowSeconds: DENIAL_WINDOW_SECONDS,
    }, 'Repeated authorization denials detected');

    try {
      await dependencies.createAdminNotification({
        type: 'SECURITY_INCIDENT',
        title: 'Repeated authorization denials',
        message: `Authenticated account ${actorLabel} received ${count} authorization denials within five minutes. Review the security audit log.`,
        link: '/audit-log',
      });
    } catch (error) {
      // Keep a short retry cooldown after a notification failure. Deleting the
      // dedup key here lets every following denied request hammer the notifier.
      await dependencies.redis.expire(alertKey, ALERT_RETRY_COOLDOWN_SECONDS).catch(() => undefined);
      dependencies.error({
        actorHash: actorLabel,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }, 'Failed to publish authorization-denial alert');
    }
  } catch (error) {
    dependencies.warn({
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }, 'Authorization-denial monitoring unavailable');
  }
}
