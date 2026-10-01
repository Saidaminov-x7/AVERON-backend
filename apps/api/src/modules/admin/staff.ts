// apps/api/src/modules/admin/staff.ts
// Управление сотрудниками и ролями административной панели (только для SUPER_ADMIN)

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { AdminRole, Role } from '@prisma/client';
import { requireAdminRole } from '../../lib/adminMiddleware';
import { passwordValidation } from '../auth/schemas';
import { uzbekPhoneSchema } from '../auth/phone';

const createStaffSchema = z.object({
email: z.string().trim().email().transform((value) => value.toLowerCase()),
  adminRole: z.nativeEnum(AdminRole),
  name: z.string().min(2).optional(),
  phone: uzbekPhoneSchema.optional(),
  password: passwordValidation.optional(),
  telegramId: z.string().trim().regex(/^\d{5,20}$/, 'Telegram ID должен содержать 5–20 цифр').optional().or(z.literal('')),
});

const updateStaffSchema = z.object({
  adminRole: z.nativeEnum(AdminRole).optional(),
  telegramId: z.string().trim().regex(/^\d{5,20}$/, 'Telegram ID должен содержать 5–20 цифр').optional().or(z.literal('')),
});

export const staffModule: FastifyPluginAsync = async (server) => {
  // Доступ только для SUPER_ADMIN
  const preHandler = [requireAdminRole(AdminRole.SUPER_ADMIN)];

  /**
   * GET /admin/staff — список всех сотрудников
   */
  server.get('/', { preHandler }, async (request: FastifyRequest) => {
    const staff = await request.server.prisma.user.findMany({
      where: {
        OR: [
          { adminRole: { not: null } },
          { role: Role.ADMIN },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        telegramId: true,
        role: true,
        adminRole: true,
        avatar: true,
        isBlocked: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return staff.map((s) => ({
      ...s,
      adminRole: s.adminRole ?? (s.role === Role.ADMIN ? AdminRole.SUPER_ADMIN : AdminRole.SUPPORT),
    }));
  });

  /**
   * POST /admin/staff — добавить сотрудника (существующего пользователя или нового)
   */
  server.post('/', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const dto = createStaffSchema.parse(request.body);

    const existingUser = await request.server.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      // Обновляем роль существующего пользователя
      const updated = await request.server.prisma.user.update({
        where: { id: existingUser.id },
        data: {
          role: Role.ADMIN,
          adminRole: dto.adminRole,
          ...(dto.name && { name: dto.name }),
          ...(dto.telegramId !== undefined && { telegramId: dto.telegramId || null }),
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          telegramId: true,
          role: true,
          adminRole: true,
          createdAt: true,
          lastLoginAt: true,
        },
      });

      // Логируем в AuditLog
      await request.server.prisma.auditLog.create({
        data: {
          userId: request.user.userId,
          action: 'STAFF_ROLE_ASSIGNED',
          resource: 'user',
          resourceId: existingUser.id,
          meta: { email: dto.email, adminRole: dto.adminRole },
          ip: request.ip,
        },
      });

      return reply.status(200).send(updated);
    }

    // Создаем нового пользователя
    if (!dto.password || !dto.phone) {
      return reply.status(400).send({ message: 'Для нового сотрудника укажите пароль и номер телефона.' });
    }
    const passwordHash = await argon2.hash(dto.password);

    const newUser = await request.server.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        telegramId: dto.telegramId || null,
        passwordHash,
        name: dto.name || dto.email.split('@')[0],
        role: Role.ADMIN,
        adminRole: dto.adminRole,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        telegramId: true,
        role: true,
        adminRole: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    await request.server.prisma.auditLog.create({
      data: {
        userId: request.user.userId,
        action: 'STAFF_CREATED',
        resource: 'user',
        resourceId: newUser.id,
        meta: { email: dto.email, adminRole: dto.adminRole },
        ip: request.ip,
      },
    });

    return reply.status(201).send(newUser);
  });

  /**
   * PATCH /admin/staff/:id — изменить роль сотрудника
   */
  server.patch<{ Params: { id: string } }>('/:id', { preHandler }, async (request, reply) => {
    const { id } = request.params;
    const dto = updateStaffSchema.parse(request.body);
    if (!dto.adminRole && dto.telegramId === undefined) {
      return reply.status(400).send({ message: 'Укажите роль или Telegram ID для изменения.' });
    }

    const user = await request.server.prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.status(404).send({ message: 'User not found' });
    }

    // Защита: нельзя понизить роль главного супер-админа
    if (user.email === 'vosilhojasaidaminov@gmail.com' && dto.adminRole && dto.adminRole !== AdminRole.SUPER_ADMIN) {
      return reply.status(400).send({ message: 'Cannot change role of primary Super Admin' });
    }

    const updated = await request.server.prisma.user.update({
      where: { id },
      data: {
        ...(dto.adminRole && { adminRole: dto.adminRole }),
        role: Role.ADMIN,
        ...(dto.telegramId !== undefined && { telegramId: dto.telegramId || null }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        telegramId: true,
        role: true,
        adminRole: true,
      },
    });

    await request.server.prisma.auditLog.create({
      data: {
        userId: request.user.userId,
        action: 'STAFF_ROLE_UPDATED',
        resource: 'user',
        resourceId: id,
        meta: { oldRole: user.adminRole, newRole: dto.adminRole },
        ip: request.ip,
      },
    });

    return updated;
  });

  /**
   * DELETE /admin/staff/:id — отозвать доступ сотрудника
   */
  server.delete<{ Params: { id: string } }>('/:id', { preHandler }, async (request, reply) => {
    const { id } = request.params;

    const user = await request.server.prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.status(404).send({ message: 'User not found' });
    }

    if (user.email === 'vosilhojasaidaminov@gmail.com') {
      return reply.status(400).send({ message: 'Cannot revoke access of primary Super Admin' });
    }

    if (user.id === request.user.userId) {
      return reply.status(400).send({ message: 'Cannot revoke your own access' });
    }

    await request.server.prisma.user.update({
      where: { id },
      data: {
        adminRole: null,
        role: Role.USER,
      },
    });

    await request.server.prisma.auditLog.create({
      data: {
        userId: request.user.userId,
        action: 'STAFF_REVOKED',
        resource: 'user',
        resourceId: id,
        meta: { email: user.email },
        ip: request.ip,
      },
    });

    return reply.status(204).send();
  });
};
