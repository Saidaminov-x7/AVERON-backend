// apps/api/src/modules/auth/__tests__/auth.test.ts

import { describe, it, expect } from 'vitest';
import { registerSchema, loginSchema, verify2faSchema, resetPasswordSchema } from '../schemas';

describe('Auth Module Validation & Password Policy', () => {
  describe('registerSchema', () => {
    it('принимает корректные данные с сильным паролем', () => {
      const validData = {
        email: 'user@ijarauz.uz',
        phone: '+998901234567',
        password: 'Password123!',
        name: 'Vosilhoja',
        role: 'USER' as const,
      };

      const result = registerSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('отклоняет пароль короче 8 символов', () => {
      const invalidData = {
        email: 'user@ijarauz.uz',
        phone: '+998901234567',
        password: 'Pass1',
        name: 'Vosilhoja',
      };

      const result = registerSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.flatten().fieldErrors.password).toBeDefined();
      }
    });

    it('отклоняет пустой пароль', () => {
      const invalidData = {
        email: 'user@ijarauz.uz',
        phone: '+998901234567',
        password: '',
        name: 'Vosilhoja',
      };

      const result = registerSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('отклоняет некорректный телефон', () => {
      const invalidData = {
        email: 'user@ijarauz.uz',
        phone: '123',
        password: 'Password123',
        name: 'Vosilhoja',
      };

      const result = registerSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('принимает стандартный 8-значный пароль', () => {
      const validData = {
        email: 'user@ijarauz.uz',
        phone: '+998901234567',
        password: 'admin123',
        name: 'Vosilhoja',
      };

      const result = registerSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe('loginSchema', () => {
    it('валидирует корректный email и пароль', () => {
      const result = loginSchema.safeParse({
        email: 'admin@ijara.uz',
        password: 'any_password',
      });
      expect(result.success).toBe(true);
    });

    it('отклоняет некорректный email', () => {
      const result = loginSchema.safeParse({
        email: 'invalid-email',
        password: 'pass',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('verify2faSchema', () => {
    it('принимает 6-значный цифровой код', () => {
      const result = verify2faSchema.safeParse({
        tempToken: 'valid_temp_token_12345',
        code: '123456',
      });
      expect(result.success).toBe(true);
    });

    it('отклоняет код не из 6 цифр', () => {
      const result = verify2faSchema.safeParse({
        tempToken: 'valid_temp_token_12345',
        code: '1234a',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('resetPasswordSchema', () => {
    it('требует сильный новый пароль при сбросе', () => {
      const weakResult = resetPasswordSchema.safeParse({
        token: 'reset_token_12345',
        password: 'weak',
      });
      expect(weakResult.success).toBe(false);

      const strongResult = resetPasswordSchema.safeParse({
        token: 'reset_token_12345',
        password: 'StrongPassword123#',
      });
      expect(strongResult.success).toBe(true);
    });
  });
});
