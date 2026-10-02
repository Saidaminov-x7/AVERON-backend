import { z } from 'zod';

export function normalizeUzbekPhone(value: string): string | null {
  if (!/^[+\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  const national = digits.startsWith('998') ? digits.slice(3) : digits;
  return /^\d{9}$/.test(national) ? `+998${national}` : null;
}

export const uzbekPhoneSchema = z.string().max(32)
  .transform((value, context) => {
    const normalized = normalizeUzbekPhone(value);
    if (!normalized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Введите номер Узбекистана в формате +998 XX XXX XX XX',
      });
      return z.NEVER;
    }
    return normalized;
  });
