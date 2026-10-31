import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

type SecurityPrisma = FastifyInstance['prisma'];

export interface SecurityIncident {
  category: 'AUTHORIZATION_DENIALS' | 'UNKNOWN_ROUTE_SCAN' | 'RESOURCE_ID_PROBE' | 'PRIVATE_RESOURCE_ENUMERATION';
  routeTemplate?: string;
  threshold: number;
  windowSeconds: number;
}

export async function writeSecurityIncident(
  prisma: SecurityPrisma,
  logger: FastifyBaseLogger,
  incident: SecurityIncident,
): Promise<void> {
  const safeRoute = incident.routeTemplate && /^\/[A-Za-z0-9_:/-]{1,180}$/.test(incident.routeTemplate)
    ? incident.routeTemplate
    : undefined;
  try {
    await prisma.auditLog.create({
      data: {
        action: 'SECURITY_INCIDENT',
        resource: 'api_security',
        meta: {
          category: incident.category,
          ...(safeRoute ? { routeTemplate: safeRoute } : {}),
          threshold: incident.threshold,
          windowSeconds: incident.windowSeconds,
        },
      },
    });
    await prisma.adminNotification.create({
      data: {
        type: 'SECURITY_INCIDENT',
        title: 'Обнаружена подозрительная активность API',
        message: `Сработало правило безопасности ${incident.category}. Подробности без персональных данных записаны в журнал аудита.`,
        link: '/activity',
      },
    });
  } catch {
    logger.warn({ event: 'security_incident_notification_failed', category: incident.category }, 'Security incident could not be recorded');
  }
}
