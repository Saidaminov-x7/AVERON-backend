// apps/api/src/modules/auth/schemas.ts

import { z } from 'zod';
import { Role } from '@prisma/client';

export const passwordStrengthRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~])[A-Za-z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]{8,100}$/;

export const passwordValidation = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100);

export const registerSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  phone: z.string().regex(/^\+?[0-9\s-]{10,20}$/, 'Invalid phone number format'),
  password: passwordValidation,
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  // Запрещаем прямую регистрацию с ролью ADMIN через публичный эндпоинт
  role: z.literal(Role.USER).default(Role.USER),
});

export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  password: z.string().min(1, 'Password is required').max(100),
});

export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export type RefreshDto = z.infer<typeof refreshSchema>;

export const verify2faSchema = z.object({
  tempToken: z.string().min(10),
  code: z.string().length(6, 'Код должен состоять из 6 цифр').regex(/^\d{6}$/, 'Код должен содержать только цифры'),
});

export type Verify2faDto = z.infer<typeof verify2faSchema>;

export const resend2faSchema = z.object({
  tempToken: z.string().min(10),
});

export type Resend2faDto = z.infer<typeof resend2faSchema>;

export const adminTotpCodeSchema = z.object({
  code: z.string().trim().min(6).max(64),
});

export type AdminTotpCodeDto = z.infer<typeof adminTotpCodeSchema>;

export const adminTotpLoginSchema = z.object({
  challengeToken: z.string().min(40).max(128),
  code: z.string().trim().min(6).max(64),
});

export type AdminTotpLoginDto = z.infer<typeof adminTotpLoginSchema>;

export const adminTotpSensitiveActionSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  code: z.string().trim().min(6).max(64),
});

export type AdminTotpSensitiveActionDto = z.infer<typeof adminTotpSensitiveActionSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  locale: z.enum(['ru', 'uz', 'en']).optional().default('ru'),
});

export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(10, 'Invalid or expired token'),
  password: passwordValidation,
});

export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
