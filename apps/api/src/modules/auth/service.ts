// apps/api/src/modules/auth/service.ts

import { PrismaClient, User } from '@prisma/client';
import argon2 from 'argon2';
import { config } from '../../config';
import { RegisterDto } from './schemas';

class AuthService {
  constructor(private prisma: PrismaClient) {}

  // Регистрация пользователя
  async register(dto: RegisterDto): Promise<User> {
    const existingUser = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existingUser) {
      throw new Error('User with this email or phone already exists');
    }

    const passwordHash = await argon2.hash(dto.password);
    return this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash,
        name: dto.name,
        role: dto.role,
      },
    });
  }

  // Поиск пользователя по email
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  // Проверка пароля
  async verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}

export { AuthService };