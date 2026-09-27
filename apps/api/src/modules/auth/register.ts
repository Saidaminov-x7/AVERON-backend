// apps/api/src/modules/auth/register.ts

import { FastifyReply, FastifyRequest } from 'fastify';
import { RegisterDto, registerSchema } from './schemas';
import { AuthService } from './service';

export const registerHandler = async (
  request: FastifyRequest<{ Body: RegisterDto }>,
  reply: FastifyReply,
) => {
  const dto = registerSchema.parse(request.body);
  const authService = new AuthService(request.server.prisma);

  try {
    const user = await authService.register(dto);

    // Создаем системное уведомление для администраторов
    request.server.prisma.adminNotification.create({
      data: {
        type: 'NEW_USER',
        title: 'Новый пользователь',
        message: `Зарегистрирован пользователь ${user.name} (${user.email})`,
        link: '/users',
      },
    }).catch(() => {});

    // Логируем регистрацию в AuditLog
    request.server.prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'USER_REGISTERED',
        resource: 'user',
        resourceId: user.id,
        meta: { email: user.email, name: user.name },
      },
    }).catch(() => {});

    const { logUserActivity } = await import('../../lib/activityLogger');
    void logUserActivity(request.server.prisma, user.id, 'REGISTER', request, {
      email: user.email,
      name: user.name,
    });

    return reply.status(201).send({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
  } catch (err) {
    const error = err as Error;
    request.log.warn({ email: dto.email }, `Registration failed: ${error.message}`);

    // Не утекаем детали — только "user already exists" — safe to expose
    if (error.message.includes('already exists')) {
      return reply.status(409).send({ message: 'User with this email or phone already exists' });
    }

    return reply.status(400).send({ message: 'Registration failed' });
  }
};