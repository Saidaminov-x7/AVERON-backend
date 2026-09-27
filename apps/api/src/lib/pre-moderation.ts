// apps/api/src/lib/pre-moderation.ts

const PHONE_PATTERN = /(\+?\d[\d\s\-\(\)]{7,}\d)/g;
const TELEGRAM_PATTERN = /(@[a-zA-Z0-9_]{4,32}|t\.me\/[a-zA-Z0-9_]+)/g;

export function detectSuspiciousContent(description: string): { suspicious: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (PHONE_PATTERN.test(description)) reasons.push('PHONE_IN_DESCRIPTION');
  if (TELEGRAM_PATTERN.test(description)) reasons.push('TELEGRAM_CONTACT_IN_DESCRIPTION');
  return { suspicious: reasons.length > 0, reasons };
}
