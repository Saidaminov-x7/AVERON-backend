import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://averon_test:averon_test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-priority-routes-access-secret-32-chars';
  process.env.REFRESH_SECRET ??= 'test-priority-routes-refresh-secret-32';
});

import { adminModule } from './index';
import { profileModule } from './profile';
import { staffModule } from './staff';
import { themeModule } from './theme';
import { capabilitiesModule } from '../features';

type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT';
type InjectMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface PriorityRoute {
  method: InjectMethod;
  url: string;
  role: AdminRole;
  deniedRole: AdminRole;
  payload?: Record<string, unknown>;
  expectedStatus: number;
  description: string;
}

const operator = {
  id: 'operator-1',
  name: 'Operator',
  email: 'operator@example.test',
  phone: '+998901234567',
  telegramId: null,
  role: 'ADMIN',
  adminRole: 'SUPER_ADMIN' as AdminRole,
  isBlocked: false,
  isDeleted: false,
  passwordHash: 'unused-test-hash',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
};

const staffMember = {
  ...operator,
  id: 'staff-1',
  email: 'staff@example.test',
  adminRole: 'SUPPORT' as AdminRole,
};

const routes: PriorityRoute[] = [
  { method: 'GET', url: '/admin/theme', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', expectedStatus: 200, description: 'read site theme' },
  { method: 'PATCH', url: '/admin/theme', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', payload: { primaryColor: '#123456' }, expectedStatus: 200, description: 'update site theme' },
  { method: 'GET', url: '/admin/admin-theme', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', expectedStatus: 200, description: 'read admin theme' },
  { method: 'PATCH', url: '/admin/admin-theme', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', payload: { primaryColor: '#123456' }, expectedStatus: 200, description: 'update admin theme' },
  { method: 'GET', url: '/admin/staff', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', expectedStatus: 200, description: 'list staff' },
  { method: 'POST', url: '/admin/staff', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', payload: { email: staffMember.email, adminRole: 'SUPPORT' }, expectedStatus: 200, description: 'assign staff role' },
  { method: 'PATCH', url: '/admin/staff/staff-1', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', payload: { adminRole: 'MODERATOR' }, expectedStatus: 200, description: 'update staff role' },
  { method: 'DELETE', url: '/admin/staff/staff-1', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', expectedStatus: 204, description: 'revoke staff access' },
  { method: 'DELETE', url: '/admin/users/staff-1', role: 'SUPER_ADMIN', deniedRole: 'ADMIN', expectedStatus: 200, description: 'delete user' },
  { method: 'GET', url: '/api/v1/admin/ai-status', role: 'ADMIN', deniedRole: 'SUPPORT', expectedStatus: 200, description: 'read AI diagnostics' },
  { method: 'GET', url: '/api/v1/admin/recommendation-status', role: 'ADMIN', deniedRole: 'SUPPORT', expectedStatus: 200, description: 'read recommendation diagnostics' },
  { method: 'GET', url: '/api/v1/admin/integration-diagnostics', role: 'ADMIN', deniedRole: 'SUPPORT', expectedStatus: 200, description: 'read integration diagnostics' },
];

async function makeApp(adminRole: AdminRole) {
  const app = Fastify();
  app.decorate('prisma', {
    user: {
      findUnique: vi.fn(async (args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === operator.id) return { ...operator, adminRole };
        if (args.where.id === staffMember.id || args.where.email === staffMember.email) return staffMember;
        return null;
      }),
      findMany: vi.fn(async () => [staffMember]),
      update: vi.fn(async () => staffMember),
      delete: vi.fn(async () => staffMember),
    },
    themeSettings: { upsert: vi.fn(async () => ({ id: 'singleton', primaryColor: '#123456' })) },
    adminThemeSettings: { upsert: vi.fn(async () => ({ id: 'singleton', primaryColor: '#123456' })) },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  } as never);
  app.decorate('redis', {
    del: vi.fn(async () => 1),
    ping: vi.fn(async () => 'PONG'),
  } as never);

  await app.register(fastifyJwt, { secret: 'test-priority-routes-access-secret-32-chars' });
  await app.register(adminModule, { prefix: '/admin' });
  await app.register(staffModule, { prefix: '/admin/staff' });
  await app.register(profileModule, { prefix: '/admin' });
  await app.register(themeModule, { prefix: '/admin' });
  await app.register(capabilitiesModule, { prefix: '/api/v1' });
  await app.ready();
  return app;
}

async function send(app: Awaited<ReturnType<typeof makeApp>>, route: PriorityRoute, adminRole?: AdminRole) {
  const headers = adminRole
    ? { authorization: `Bearer ${app.jwt.sign({ userId: operator.id, role: 'ADMIN', adminRole })}` }
    : undefined;
  return app.inject({ method: route.method, url: route.url, headers, payload: route.payload });
}

describe('priority admin route authentication and role coverage', () => {
  it.each(routes)('$method $url ($description): 401, 403, then expected authorized status', async (route) => {
    const anonymousApp = await makeApp(route.role);
    const anonymous = await send(anonymousApp, route);
    expect(anonymous.statusCode).toBe(401);
    await anonymousApp.close();

    const deniedApp = await makeApp(route.deniedRole);
    const denied = await send(deniedApp, route, route.deniedRole);
    expect(denied.statusCode).toBe(403);
    await deniedApp.close();

    const authorizedApp = await makeApp(route.role);
    const authorized = await send(authorizedApp, route, route.role);
    expect(authorized.statusCode).toBe(route.expectedStatus);
    await authorizedApp.close();
  });
});
