// apps/api/src/modules/admin/service.ts
// Бизнес-логика для всех admin-операций + запись в AuditLog

import { PrismaClient, ModerationStatus, ListingStatus, Role, Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { MediaService } from '../media/service';
import { UpdateListingDto } from '../listings/schemas';
import {
  AdminListingsFilterDto,
  AdminUsersFilterDto,
  CreatePageDto,
  UpdatePageDto,
  UpdateSiteSettingsDto,
} from './schemas';

export class AdminService {
  constructor(public readonly prisma: PrismaClient) { }

  // ─── Вспомогательный метод: запись в AuditLog ────────────────────────────────

  private async log(params: {
    adminId: string;
    action: string;
    resource?: string;
    resourceId?: string;
    meta?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }) {
    await this.prisma.auditLog.create({
      data: {
        userId: params.adminId,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        meta: params.meta as Prisma.InputJsonValue,
        ip: params.ip,
        userAgent: params.userAgent,
        timestamp: new Date(),
      },
    });
  }

  // ─── Объявления ──────────────────────────────────────────────────────────────

  async updateListing(id: string, dto: UpdateListingDto, adminId: string, ip?: string) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' }, select: { autoModerationEnabled: true } });
    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.rooms !== undefined && { rooms: dto.rooms }),
        ...(dto.area !== undefined && { area: dto.area }),
        ...(dto.floor !== undefined && { floor: dto.floor }),
        ...(dto.totalFloors !== undefined && { totalFloors: dto.totalFloors }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.district !== undefined && { district: dto.district }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.amenities !== undefined && { amenities: dto.amenities }),
        status: ListingStatus.ACTIVE,
        moderationStatus: settings?.autoModerationEnabled ? ModerationStatus.APPROVED : ModerationStatus.PENDING,
        moderationNote: null,
      },
      include: { owner: { select: { id: true, name: true, email: true } }, images: true },
    });
    await this.log({ adminId, action: 'LISTING_UPDATED', resource: 'listing', resourceId: id, meta: { title: updated.title }, ip });
    return updated;
  }

  async getListings(filter: AdminListingsFilterDto) {
    const { page, limit, status, moderationStatus, city, ownerId, dateFrom, dateTo, sortBy, sortOrder } = filter;
    const skip = (page - 1) * limit;

    const where: Prisma.ListingWhereInput = {
      // По умолчанию исключаем удалённые (чтобы "Все" не включал DELETED)
      ...(status ? { status } : { status: { not: ListingStatus.DELETED } }),
      ...(moderationStatus && { moderationStatus }),
      ...(city && { city: { contains: city, mode: 'insensitive' } }),
      ...(ownerId && { ownerId }),
      ...((dateFrom || dateTo) && {
        createdAt: {
          ...(dateFrom && { gte: new Date(dateFrom) }),
          ...(dateTo && { lte: new Date(dateTo) }),
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          owner: { select: { id: true, name: true, email: true, phone: true, avatar: true } },
          images: { select: { id: true, url: true }, take: 3 },
          _count: { select: { favorites: true } },
        },
      }),
      this.prisma.listing.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);
    return {
      items,
      total,
      page,
      totalPages,
      meta: { total, page, limit, totalPages },
    };
  }

  async approveListing(id: string, adminId: string, ip?: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (listing.moderationStatus === ModerationStatus.APPROVED) {
      throw Object.assign(new Error('Listing is already approved'), { statusCode: 400 });
    }

    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        moderationStatus: ModerationStatus.APPROVED,
        status: ListingStatus.ACTIVE,
        moderationNote: null,
      },
    });

    await this.log({
      adminId,
      action: 'LISTING_APPROVED',
      resource: 'listing',
      resourceId: id,
      meta: { title: listing.title },
      ip,
      userAgent: 'admin-panel',
    });

    return updated;
  }

  async rejectListing(id: string, reason: string, adminId: string, ip?: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (listing.moderationStatus === ModerationStatus.REJECTED) {
      throw Object.assign(new Error('Listing is already rejected'), { statusCode: 400 });
    }

    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        moderationStatus: ModerationStatus.REJECTED,
        status: ListingStatus.DRAFT,
        moderationNote: reason,
      },
    });

    await this.log({
      adminId,
      action: 'LISTING_REJECTED',
      resource: 'listing',
      resourceId: id,
      meta: { title: listing.title, reason },
      ip,
      userAgent: 'admin-panel',
    });

    return updated;
  }

  async requestListingChanges(id: string, comment: string, adminId: string, ip?: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (listing.moderationStatus === ModerationStatus.CHANGES_REQUESTED) {
      throw Object.assign(new Error('Changes are already requested'), { statusCode: 400 });
    }

    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        moderationStatus: ModerationStatus.CHANGES_REQUESTED,
        moderationNote: comment,
      },
    });

    await this.log({
      adminId,
      action: 'LISTING_CHANGES_REQUESTED',
      resource: 'listing',
      resourceId: id,
      meta: { title: listing.title, comment },
      ip,
      userAgent: 'admin-panel',
    });

    return updated;
  }

  async deleteListing(id: string, adminId: string, ip?: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });

    await this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.DELETED },
    });

    await this.log({
      adminId,
      action: 'LISTING_DELETED',
      resource: 'listing',
      resourceId: id,
      meta: { title: listing.title },
      ip,
      userAgent: 'admin-panel',
    });
  }

  /**
   * Присвоить/снять статус "Проверено Ijarauz"
   */
  async verifyListing(id: string, isVerified: boolean, adminId: string, ip?: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });

    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        isVerified,
        verifiedAt: isVerified ? new Date() : null,
        verifiedBy: isVerified ? adminId : null,
      },
    });

    await this.log({
      adminId,
      action: isVerified ? 'LISTING_VERIFIED' : 'LISTING_UNVERIFIED',
      resource: 'listing',
      resourceId: id,
      meta: { title: listing.title, isVerified },
      ip,
      userAgent: 'admin-panel',
    });

    return updated;
  }

  /**
   * Получить список жалоб на объявления
   */
  async getReports(params: { status?: 'OPEN' | 'RESOLVED' | 'DISMISSED'; page?: number; limit?: number }) {
    const { status, page = 1, limit = 20 } = params;
    const skip = (page - 1) * limit;

    const where = status ? { status } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.listingReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              description: true,
              city: true,
              district: true,
              address: true,
              price: true,
              type: true,
              rooms: true,
              area: true,
              floor: true,
              totalFloors: true,
              status: true,
              isVerified: true,
              images: { select: { url: true } },
              owner: { select: { id: true, name: true, email: true, phone: true, avatar: true } },
            },
          },
          reporter: { select: { id: true, name: true, email: true, phone: true } },
        },
      }),
      this.prisma.listingReport.count({ where }),
    ]);

    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Обновить статус жалобы
   */
  async updateReportStatus(id: string, status: 'OPEN' | 'RESOLVED' | 'DISMISSED', adminId: string, ip?: string) {
    const report = await this.prisma.listingReport.findUnique({ where: { id } });
    if (!report) throw Object.assign(new Error('Report not found'), { statusCode: 404 });

    const updated = await this.prisma.listingReport.update({
      where: { id },
      data: { status },
    });

    await this.log({
      adminId,
      action: `REPORT_${status}`,
      resource: 'report',
      resourceId: id,
      meta: { listingId: report.listingId, status },
      ip,
      userAgent: 'admin-panel',
    });

    return updated;
  }

  // ─── Пользователи ────────────────────────────────────────────────────────────

  async getUsers(filter: AdminUsersFilterDto) {
    const { page, limit, role, isBlocked, isStaff, search, dateFrom, dateTo, sortBy, sortOrder, order, lastActiveDays, createdAfterDays, createdBeforeDays } = filter;
    const effectiveOrder = order ?? sortOrder;
    const skip = (page - 1) * limit;

    const now = new Date();
    const and: Prisma.UserWhereInput[] = [];
    if (role) {
      const dbRole = role === 'TENANT' ? Role.USER : (role as Role);
      and.push({ role: dbRole });
    }
    if (isBlocked !== undefined) and.push({ isBlocked });
    if (isStaff === true) {
      and.push({ OR: [{ role: Role.ADMIN }, { adminRole: { not: null } }] });
    } else if (isStaff === false) {
      and.push({ role: { in: [Role.USER, Role.LANDLORD] }, adminRole: null });
    }
    if (search && search.trim()) {
      const q = search.trim();
      and.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { id: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (dateFrom || dateTo) {
      and.push({
        createdAt: {
          ...(dateFrom && { gte: new Date(dateFrom) }),
          ...(dateTo && { lte: new Date(`${dateTo}T23:59:59.999Z`) }),
        },
      });
    }
    if (lastActiveDays) {
      const from = new Date(now.getTime() - lastActiveDays * 24 * 60 * 60 * 1000);
      const to = createdAfterDays
        ? new Date(now.getTime() - createdAfterDays * 24 * 60 * 60 * 1000)
        : undefined;
      and.push({ lastLoginAt: { gte: from, ...(to && { lt: to }) } });
    }
    if (isBlocked && createdAfterDays) {
      and.push({
        blockedAt: {
          gte: new Date(now.getTime() - (createdAfterDays + (createdBeforeDays || 0)) * 24 * 60 * 60 * 1000),
          ...(createdBeforeDays && { lt: new Date(now.getTime() - createdBeforeDays * 24 * 60 * 60 * 1000) }),
        },
      });
    } else if (createdAfterDays && !lastActiveDays) {
      and.push({
        createdAt: {
          gte: new Date(now.getTime() - createdAfterDays * 24 * 60 * 60 * 1000),
          ...(createdBeforeDays && { lt: new Date(now.getTime() - createdBeforeDays * 24 * 60 * 60 * 1000) }),
        },
      });
    }

    const where: Prisma.UserWhereInput = {
      AND: and,
    };

    const orderBy: Prisma.UserOrderByWithRelationInput = sortBy === 'listingsCount'
      ? { listings: { _count: effectiveOrder } }
      : { [sortBy]: effectiveOrder };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          adminRole: true,
          verified: true,
          isBlocked: true,
          blockedAt: true,
          blockedReason: true,
          createdAt: true,
          avatar: true,
          lastLoginAt: true,
          _count: { select: { listings: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        verified: true,
        isBlocked: true,
        blockedAt: true,
        blockedReason: true,
        createdAt: true,
        updatedAt: true,
        avatar: true,
        listings: {
          where: { status: { not: ListingStatus.DELETED } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, title: true, status: true, moderationStatus: true, price: true, createdAt: true },
        },
        auditLogs: {
          orderBy: { timestamp: 'desc' },
          take: 20,
          select: { id: true, action: true, resource: true, timestamp: true, meta: true },
        },
        _count: { select: { listings: true, favorites: true } },
      },
    });

    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    return user;
  }

  async blockUser(id: string, reason: string | undefined, adminId: string, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (user.role === Role.ADMIN) {
      throw Object.assign(new Error('Cannot block an ADMIN user'), { statusCode: 403 });
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isBlocked: true, blockedAt: new Date(), blockedReason: reason },
      select: { id: true, name: true, email: true, isBlocked: true, blockedAt: true },
    });

    await this.log({
      adminId,
      action: 'USER_BLOCKED',
      resource: 'user',
      resourceId: id,
      meta: { reason, targetName: user.name },
      ip,
    });

    return updated;
  }

  async unblockUser(id: string, adminId: string, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isBlocked: false, blockedAt: null, blockedReason: null },
      select: { id: true, name: true, email: true, isBlocked: true },
    });

    await this.log({
      adminId,
      action: 'USER_UNBLOCKED',
      resource: 'user',
      resourceId: id,
      meta: { targetName: user.name },
      ip,
    });

    return updated;
  }

  async updateUserRole(id: string, role: Role, adminId: string, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const updated = await this.prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, name: true, email: true, role: true },
    });

    await this.log({
      adminId,
      action: 'USER_ROLE_CHANGED',
      resource: 'user',
      resourceId: id,
      meta: { oldRole: user.role, newRole: role, targetName: user.name },
      ip,
    });

    return updated;
  }

  async changeUserRole(id: string, role: Role, adminId: string, ip?: string) {
    return this.updateUserRole(id, role, adminId, ip);
  }

  async updateUser(id: string, dto: { name?: string; phone?: string }, adminId: string, ip?: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
      select: { id: true, name: true, email: true, phone: true, role: true, adminRole: true, avatar: true },
    });

    await this.log({
      adminId,
      action: 'USER_UPDATED',
      resource: 'user',
      resourceId: id,
      meta: { nameChanged: dto.name !== undefined, phoneChanged: dto.phone !== undefined },
      ip,
    });
    return updated;
  }

  /**
   * Обновить пароль администратора
   */
  async updateAdminPassword(adminId: string, currentPassword: string, newPassword: string, ip?: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
    });
    if (!admin) throw Object.assign(new Error('Admin not found'), { statusCode: 404 });

    // Проверяем текущий пароль
    const isValid = await argon2.verify(admin.passwordHash, currentPassword);
    if (!isValid) {
      throw Object.assign(new Error('Current password is incorrect'), { statusCode: 400 });
    }

    // Хэшируем новый пароль
    const newPasswordHash = await argon2.hash(newPassword);

    await this.prisma.user.update({
      where: { id: adminId },
      data: { passwordHash: newPasswordHash },
    });

    await this.log({
      adminId,
      action: 'ADMIN_PASSWORD_CHANGED',
      resource: 'admin',
      resourceId: adminId,
      meta: { adminName: admin.name },
      ip,
    });
  }

  async exportUsers(filter: Omit<AdminUsersFilterDto, 'page' | 'limit'>) {
    const { role, isBlocked, isStaff, search, dateFrom, dateTo, sortBy, sortOrder, lastActiveDays, createdAfterDays } = filter;
    const now = new Date();

    const where: Prisma.UserWhereInput = {
      AND: [
        ...(role ? [{ role: role === 'TENANT' ? Role.USER : (role as Role) }] : []),
        ...(isBlocked !== undefined ? [{ isBlocked }] : []),
        ...(isStaff === true ? [{ OR: [{ role: Role.ADMIN }, { adminRole: { not: null } }] }] : []),
        ...(isStaff === false ? [{ role: { in: [Role.USER, Role.LANDLORD] }, adminRole: null }] : []),
        ...(search ? [{
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search, mode: 'insensitive' as const } },
            { id: { contains: search, mode: 'insensitive' as const } },
          ],
        }] : []),
        ...((dateFrom || dateTo) ? [{
          createdAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo && { lte: new Date(`${dateTo}T23:59:59.999Z`) }),
          },
        }] : []),
        ...(lastActiveDays ? [{ lastLoginAt: { gte: new Date(now.getTime() - lastActiveDays * 24 * 60 * 60 * 1000) } }] : []),
        ...(createdAfterDays ? [{ createdAt: { gte: new Date(now.getTime() - createdAfterDays * 24 * 60 * 60 * 1000) } }] : []),
      ],
    };

    const orderBy: Prisma.UserOrderByWithRelationInput = sortBy === 'listingsCount'
      ? { listings: { _count: sortOrder } }
      : { [sortBy]: sortOrder };

    return this.prisma.user.findMany({
      where,
      orderBy,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        verified: true,
        isBlocked: true,
        createdAt: true,
        _count: { select: { listings: true } },
      },
    });
  }

  // ─── Статистика ──────────────────────────────────────────────────────────────

  async getOverviewStats() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const todayKey = todayStart.toISOString().slice(0, 10);
    const yesterdayKey = yesterdayStart.toISOString().slice(0, 10);

    // Параллельные запросы для реальной статистики
    const [
      visitorsToday,
      visitorsYesterday,
      activeListings,
      activeListingsPrevMonth,
      newUsersToday,
      newUsersYesterday,
      newUsersLast30Days,
      newUsersPrev30Days,
      activeUsers,
      activeUsersPrev,
      blockedUsers,
      pendingListings,
      pendingListingsYesterday,
      topListings,
      recentComplaints,
      moderationStats,
      recentActions,
    ] = await Promise.all([
      // Честный подсчет уникальных посетителей за сегодня и вчера по VisitLog
      this.prisma.visitLog.count({
        where: { dayKey: todayKey },
      }),
      this.prisma.visitLog.count({
        where: { dayKey: yesterdayKey },
      }),
      // Активные объявления
      this.prisma.listing.count({
        where: { status: ListingStatus.ACTIVE, moderationStatus: ModerationStatus.APPROVED },
      }),
      this.prisma.listing.count({
        where: {
          status: ListingStatus.ACTIVE,
          moderationStatus: ModerationStatus.APPROVED,
          updatedAt: { lt: monthStart },
        },
      }),
      // Новые пользователи (сегодня и вчера)
      this.prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.user.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
      // Новые пользователи (последние 30 дней)
      this.prisma.user.count({
        where: { createdAt: { gte: thirtyDaysAgo } },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: sixtyDaysAgo,
            lt: thirtyDaysAgo,
          },
        },
      }),
      // Активные пользователи (lastLoginAt за последние 30 дней)
      this.prisma.user.count({
        where: { lastLoginAt: { gte: thirtyDaysAgo } },
      }),
      this.prisma.user.count({
        where: {
          lastLoginAt: {
            gte: sixtyDaysAgo,
            lt: thirtyDaysAgo,
          },
        },
      }),
      // Заблокированные пользователи
      this.prisma.user.count({ where: { isBlocked: true } }),
      // Ожидают модерации
      this.prisma.listing.count({ where: { moderationStatus: ModerationStatus.PENDING } }),
      this.prisma.listing.count({
        where: { moderationStatus: ModerationStatus.PENDING, createdAt: { lt: todayStart } },
      }),
      // Топ 5 объявлений по просмотрам
      this.getTopListings(),
      // Последние 5 жалоб
      this.getRecentComplaints(),
      // Конверсия модерации
      this.getModerationStats(),
      // Последние 5 действий (AuditLog)
      this.prisma.auditLog.findMany({
        where: {
          action: {
            in: [
              'LISTING_CREATED', 'LISTING_APPROVED', 'LISTING_REJECTED', 
              'LISTING_CHANGES_REQUESTED', 'LISTING_UPDATED', 'LISTING_DELETED',
              'USER_CREATED', 'USER_BLOCKED', 'USER_UNBLOCKED', 'USER_ROLE_CHANGED',
            ],
          },
        },
        orderBy: { timestamp: 'desc' },
        take: 5,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
    ]);

    // Процентные изменения
    const calcChange = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100 * 10) / 10;
    };

    return {
      visitorsToday: {
        value: visitorsToday,
        change: calcChange(visitorsToday, visitorsYesterday),
        trend: visitorsToday >= visitorsYesterday ? 'up' : 'down',
      },
      activeListings: {
        value: activeListings,
        change: calcChange(activeListings, activeListingsPrevMonth),
        trend: activeListings >= activeListingsPrevMonth ? 'up' : 'down',
      },
      newUsers: {
        value: newUsersLast30Days,
        change: calcChange(newUsersLast30Days, newUsersPrev30Days),
        trend: newUsersLast30Days >= newUsersPrev30Days ? 'up' : 'down',
      },
      activeUsers: {
        value: activeUsers,
        change: calcChange(activeUsers, activeUsersPrev),
        trend: activeUsers >= activeUsersPrev ? 'up' : 'down',
      },
      blockedUsers: {
        value: blockedUsers,
        change: 0, // Нет предыдущего периода для сравнения
        trend: 'neutral',
      },
      pendingModeration: {
        value: pendingListings,
        change: pendingListings - pendingListingsYesterday,
        trend: pendingListings <= pendingListingsYesterday ? 'up' : 'down',
      },
      topListings,
      recentComplaints,
      moderationStats,
      recentActions: recentActions.map((log) => ({
        id: log.id,
        action: log.action,
        resource: log.resource,
        resourceId: log.resourceId,
        meta: log.meta,
        timestamp: log.timestamp,
        user: log.user ? {
          id: log.user.id,
          name: log.user.name,
          email: log.user.email,
        } : null,
      })),
    };
  }

  async getTrafficStats(days: number) {
    const now = new Date();
    const dateFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [visits, users, listings] = await Promise.all([
      this.prisma.visitLog.groupBy({
        by: ['dayKey'],
        where: { createdAt: { gte: dateFrom } },
        _count: { id: true },
        orderBy: { dayKey: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { createdAt: { gte: dateFrom } },
        select: { createdAt: true },
      }),
      this.prisma.listing.findMany({
        where: { createdAt: { gte: dateFrom } },
        select: { createdAt: true },
      }),
    ]);

    // Группируем по дням без рандома
    const dayMap = new Map<string, { date: string; registrations: number; listings: number; visitors: number }>();

    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - (days - 1 - i) * 24 * 60 * 60 * 1000);
      const key = date.toISOString().split('T')[0];
      dayMap.set(key, { date: key, registrations: 0, listings: 0, visitors: 0 });
    }

    for (const v of visits) {
      const entry = dayMap.get(v.dayKey);
      if (entry) entry.visitors = v._count.id;
    }

    for (const u of users) {
      const key = u.createdAt.toISOString().split('T')[0];
      const entry = dayMap.get(key);
      if (entry) entry.registrations++;
    }

    for (const l of listings) {
      const key = l.createdAt.toISOString().split('T')[0];
      const entry = dayMap.get(key);
      if (entry) entry.listings++;
    }

    return Array.from(dayMap.values());
  }

  async getListingsByCity() {
    const result = await this.prisma.listing.groupBy({
      by: ['city'],
      where: { status: ListingStatus.ACTIVE, moderationStatus: ModerationStatus.APPROVED },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    return result.map((r) => ({ city: r.city, count: r._count.id }));
  }

  async getActivityFeed(limit = 20) {
    const logs = await this.prisma.auditLog.findMany({
      take: limit,
      orderBy: { timestamp: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    return logs.map((log) => ({
      id: log.id,
      action: log.action,
      resource: log.resource,
      resourceId: log.resourceId,
      meta: log.meta,
      actor: log.user,
      timestamp: log.timestamp,
    }));
  }

  /** Логи действий пользователя */
  async getAuditLogs(userId?: string) {
    const where: Prisma.AuditLogWhereInput = {};
    if (userId) {
      where.userId = userId;
    }

    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 50,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    return logs.map((log) => ({
      id: log.id,
      action: log.action,
      resource: log.resource,
      resourceId: log.resourceId,
      meta: log.meta,
      timestamp: log.timestamp,
      actor: log.user,
    }));
  }

  /** Топ 5 объявлений по количеству просмотров */
  async getTopListings() {
    return this.prisma.listing.findMany({
      where: {
        status: ListingStatus.ACTIVE,
        moderationStatus: ModerationStatus.APPROVED,
      },
      orderBy: { viewsCount: 'desc' },
      take: 5,
      select: {
        id: true,
        title: true,
        city: true,
        price: true,
        viewsCount: true,
        createdAt: true,
        owner: { select: { name: true } },
        images: { select: { url: true }, take: 1 },
      },
    });
  }

  /** Последние 5 жалоб на объявления */
  async getRecentComplaints() {
    return this.prisma.listing.findMany({
      where: {
        moderationStatus: ModerationStatus.REJECTED,
        moderationNote: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        title: true,
        city: true,
        moderationNote: true,
        updatedAt: true,
        owner: { select: { name: true, email: true } },
      },
    });
  }

  /** Конверсия модерации: одобрено/отклонено/ожидает за последние 30 дней */
  async getModerationStats() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [approved, rejected, pending, total] = await Promise.all([
      this.prisma.listing.count({
        where: { moderationStatus: ModerationStatus.APPROVED, updatedAt: { gte: since } },
      }),
      this.prisma.listing.count({
        where: { moderationStatus: ModerationStatus.REJECTED, updatedAt: { gte: since } },
      }),
      this.prisma.listing.count({
        where: { moderationStatus: ModerationStatus.PENDING },
      }),
      this.prisma.listing.count({
        where: { updatedAt: { gte: since } },
      }),
    ]);

    const conversionRate = total > 0 ? Math.round((approved / total) * 100) : 0;

    return { approved, rejected, pending, total, conversionRate };
  }

  // ─── Динамические страницы ───────────────────────────────────────────────────

  async getPages(params: { page: number; limit: number }) {
    const { page, limit } = params;
    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.page.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { author: { select: { id: true, name: true } } },
      }),
      this.prisma.page.count(),
    ]);
    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getPageById(id: string) {
    const page = await this.prisma.page.findUnique({
      where: { id },
      include: { author: { select: { id: true, name: true } } },
    });
    if (!page) throw Object.assign(new Error('Page not found'), { statusCode: 404 });
    return page;
  }

  async createPage(dto: CreatePageDto, authorId: string) {
    // Проверяем уникальность slug
    const exists = await this.prisma.page.findUnique({ where: { slug: dto.slug } });
    if (exists) throw Object.assign(new Error('Slug already exists'), { statusCode: 409 });

    // Создаём страницу
    const page = await this.prisma.page.create({
      data: { ...dto, authorId },
      include: { author: { select: { id: true, name: true } } },
    });

    // Автоматически добавляем страницу в навигацию (подвал)
    const navLink = {
      label: dto.title,
      href: `/pages/${dto.slug}`,
      position: "footer",
    };

    await this.prisma.siteSettings.upsert({
      where: { id: "singleton" },
      update: {
        navLinks: {
          push: navLink,
        },
      },
      create: {
        id: "singleton",
        navLinks: [navLink],
      },
    });

    return page;
  }

  async updatePage(id: string, dto: UpdatePageDto, adminId: string) {
    const page = await this.prisma.page.findUnique({ where: { id } });
    if (!page) throw Object.assign(new Error('Page not found'), { statusCode: 404 });

    // Проверяем уникальность slug при изменении
    if (dto.slug && dto.slug !== page.slug) {
      const slugExists = await this.prisma.page.findUnique({ where: { slug: dto.slug } });
      if (slugExists) throw Object.assign(new Error('Slug already exists'), { statusCode: 409 });
    }

    const updated = await this.prisma.page.update({
      where: { id },
      data: dto,
      include: { author: { select: { id: true, name: true } } },
    });

    await this.log({ adminId, action: 'PAGE_UPDATED', resource: 'page', resourceId: id, meta: { slug: page.slug } });
    return updated;
  }

  async togglePageMaintenance(id: string, adminId: string) {
    const page = await this.prisma.page.findUnique({ where: { id } });
    if (!page) throw Object.assign(new Error('Page not found'), { statusCode: 404 });

    const updated = await this.prisma.page.update({
      where: { id },
      data: { isUnderMaintenance: !page.isUnderMaintenance },
    });

    await this.log({
      adminId,
      action: updated.isUnderMaintenance ? 'PAGE_MAINTENANCE_ENABLED' : 'PAGE_MAINTENANCE_DISABLED',
      resource: 'page',
      resourceId: id,
      meta: { slug: page.slug },
      userAgent: 'admin-panel',
    });

    return updated;
  }

  async deletePage(id: string, adminId: string) {
    const page = await this.prisma.page.findUnique({ where: { id } });
    if (!page) throw Object.assign(new Error('Page not found'), { statusCode: 404 });

    await this.prisma.page.delete({ where: { id } });
    await this.log({
      adminId,
      action: 'PAGE_DELETED',
      resource: 'page',
      resourceId: id,
      meta: { slug: page.slug },
      userAgent: 'admin-panel',
    });
  }

  // ─── Настройки сайта ─────────────────────────────────────────────────────────

  async getSiteSettings() {
    return this.prisma.siteSettings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: {
        id: 'singleton',
        maintenanceMode: false,
        siteName: 'Ijarauz',
        contactEmail: 'support@ijarauz.uz',
        contactPhone: '+998 71 200-00-00',
        googleAuthEnabled: true,
        autoModerationEnabled: false,
        maxImagesPerListing: 10,
      },
      include: { updatedBy: { select: { id: true, name: true } } },
    });
  }

  async updateSiteSettings(dto: UpdateSiteSettingsDto, adminId: string, ip?: string) {
    const { navLinks, ...restDto } = dto;
    const updateData: any = {
      ...restDto,
      updatedById: adminId,
    };
    if (navLinks !== undefined) {
      updateData.navLinks = navLinks === null ? Prisma.DbNull : navLinks;
    }

    const createData: any = {
      maintenanceMode: dto.maintenanceMode ?? false,
      siteName: dto.siteName ?? 'Ijarauz',
      contactEmail: dto.contactEmail ?? 'support@ijarauz.uz',
      contactPhone: dto.contactPhone ?? '+998 71 200-00-00',
      googleAuthEnabled: dto.googleAuthEnabled ?? true,
      autoModerationEnabled: dto.autoModerationEnabled ?? false,
      maxImagesPerListing: dto.maxImagesPerListing ?? 10,
      updatedById: adminId,
    };
    if (navLinks !== undefined && navLinks !== null) {
      createData.navLinks = navLinks;
    }

    const settings = await this.prisma.siteSettings.upsert({
      where: { id: 'singleton' },
      update: updateData,
      create: createData,
      include: {
        updatedBy: { select: { id: true, name: true } },
      },
    });

    await this.log({
      adminId,
      action: 'SITE_SETTINGS_UPDATED',
      resource: 'settings',
      meta: dto,
      ip,
      userAgent: 'admin-panel',
    });

    return settings;
  }

  /**
   * Получить текущие дизайн-токены
   */
  async getThemeSettings() {
    return this.prisma.themeSettings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: {
        id: 'singleton',
        primaryColor: '#14b8a6',
        secondaryColor: '#0f766e',
        backgroundColor: '#f9fafb',
        textColor: '#111827',
        borderRadius: '0.75rem',
        fontFamily: 'Inter, sans-serif',
      },
    });
  }

  /**
   * Обновить дизайн-токены
   */
  async updateThemeSettings(dto: {
    primaryColor?: string;
    secondaryColor?: string;
    backgroundColor?: string;
    textColor?: string;
    borderRadius?: string;
    fontFamily?: string;
  }, adminId: string, ip?: string) {
    const settings = await this.prisma.themeSettings.upsert({
      where: { id: 'singleton' },
      update: { ...dto, updatedById: adminId },
      create: {
        id: 'singleton',
        primaryColor: dto.primaryColor ?? '#14b8a6',
        secondaryColor: dto.secondaryColor ?? '#0f766e',
        backgroundColor: dto.backgroundColor ?? '#f9fafb',
        textColor: dto.textColor ?? '#111827',
        borderRadius: dto.borderRadius ?? '0.75rem',
        fontFamily: dto.fontFamily ?? 'Inter, sans-serif',
        updatedById: adminId,
      },
    });

    await this.log({
      adminId,
      action: 'THEME_SETTINGS_UPDATED',
      resource: 'theme',
      meta: dto,
      ip,
      userAgent: 'admin-panel',
    });

    return settings;
  }

  // ─── Тема ПАНЕЛИ АДМИНИСТРАТОРА (AdminThemeSettings) ─────────────────────────

  private static readonly DEFAULT_ADMIN_THEME = {
    id: 'singleton',
    primaryColor: '#2563eb',
    secondaryColor: '#1d4ed8',
    backgroundColor: '#0f0f0f',
    textColor: '#f1f5f9',
    borderRadius: '0.5rem',
    fontFamily: 'Inter, sans-serif',
  };

  /**
   * Получить текущие дизайн-токены панели администратора
   */
  async getAdminThemeSettings() {
    return this.prisma.adminThemeSettings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { ...AdminService.DEFAULT_ADMIN_THEME },
    });
  }

  /**
   * Обновить дизайн-токены панели администратора
   */
  async updateAdminThemeSettings(dto: {
    primaryColor?: string;
    secondaryColor?: string;
    backgroundColor?: string;
    textColor?: string;
    borderRadius?: string;
    fontFamily?: string;
  }, adminId: string, ip?: string) {
    const defaults = AdminService.DEFAULT_ADMIN_THEME;
    const settings = await this.prisma.adminThemeSettings.upsert({
      where: { id: 'singleton' },
      update: { ...dto, updatedById: adminId },
      create: {
        id: 'singleton',
        primaryColor: dto.primaryColor ?? defaults.primaryColor,
        secondaryColor: dto.secondaryColor ?? defaults.secondaryColor,
        backgroundColor: dto.backgroundColor ?? defaults.backgroundColor,
        textColor: dto.textColor ?? defaults.textColor,
        borderRadius: dto.borderRadius ?? defaults.borderRadius,
        fontFamily: dto.fontFamily ?? defaults.fontFamily,
        updatedById: adminId,
      },
    });

    await this.log({
      adminId,
      action: 'ADMIN_THEME_SETTINGS_UPDATED',
      resource: 'admin_theme',
      meta: dto,
      ip,
      userAgent: 'admin-panel',
    });

    return settings;
  }

  /**
   * Загрузить логотип сайта
   */

  async uploadSiteLogo(file: { filename: string; mimetype: string; data: Buffer }, adminId: string, ip?: string) {
    // Получаем текущий логотип для возможной очистки старого
    const currentSettings = await this.prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      select: { logoUrl: true },
    });

    const mediaService = new MediaService(this.prisma);
    const media = await mediaService.upload(file, adminId, undefined, true);

    // Если был старый логотип и он отличается от нового, удаляем старый из Media и хранилища
    if (currentSettings?.logoUrl && currentSettings.logoUrl !== media.url) {
      const oldMedia = await this.prisma.media.findFirst({
        where: { url: currentSettings.logoUrl },
      });
      if (oldMedia) {
        await mediaService.delete(oldMedia.id, adminId, true).catch(() => {});
      }
    }

    // Обновляем настройки с новым URL логотипа и его ключом
    const settings = await this.prisma.siteSettings.upsert({
      where: { id: 'singleton' },
      update: { logoUrl: media.url, logoMediaKey: media.id, updatedById: adminId },
      create: {
        id: 'singleton',
        logoUrl: media.url,
        logoMediaKey: media.id,
        updatedById: adminId,
      },
      include: {
        updatedBy: { select: { id: true, name: true } },
      },
    });

    await this.log({
      adminId,
      action: 'SITE_LOGO_UPLOADED',
      resource: 'settings',
      meta: { logoUrl: media.url },
      ip,
      userAgent: 'admin-panel',
    });

    return settings;
  }

  /**
   * Удалить логотип сайта
   */
  async deleteSiteLogo(adminId: string, ip?: string) {
    const currentSettings = await this.prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      select: { logoUrl: true, logoMediaKey: true },
    });

    if (currentSettings?.logoUrl) {
      const mediaService = new MediaService(this.prisma);
      const oldMedia = await this.prisma.media.findFirst({
        where: { url: currentSettings.logoUrl },
      });
      if (oldMedia) {
        await mediaService.delete(oldMedia.id, adminId, true).catch(() => {});
      }
    }

    const settings = await this.prisma.siteSettings.upsert({
      where: { id: 'singleton' },
      update: { logoUrl: null, logoMediaKey: null, updatedById: adminId },
      create: {
        id: 'singleton',
        updatedById: adminId,
      },
      include: {
        updatedBy: { select: { id: true, name: true } },
      },
    });

    await this.log({
      adminId,
      action: 'SITE_LOGO_REMOVED',
      resource: 'settings',
      meta: { logoUrl: null },
      ip,
      userAgent: 'admin-panel',
    });

    return settings;
  }
}
