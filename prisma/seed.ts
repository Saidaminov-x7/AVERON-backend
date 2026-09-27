// prisma/seed.ts
/**
 * Скрипт безопасного начального наполнения базы данных (Safe Idempotent Seed)
 * Безопасен для запуска на проде: использует upsert, НЕ удаляет существующие данные пользователей,
 * объявлений или кастомных настроек конструктора страниц.
 * Запуск: pnpm prisma:seed (или npx tsx prisma/seed.ts)
 */

import { PrismaClient, Role, AdminRole } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting safe idempotent database seed...');

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || 'vosilhojasaidaminov@gmail.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || process.env.ADMIN_PASSWORD?.trim() || 'admin1';

  // Хэширование пароля супер-администратора (argon2 hash)
  const superAdminPasswordHash = await argon2.hash(adminPassword);

  // ─── 1. Супер-администратор (upsert: безопасен для существующих данных) ───────
  console.log('Ensuring Super Admin account exists...');

  const superAdmin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: Role.ADMIN,
      adminRole: AdminRole.SUPER_ADMIN,
      passwordHash: superAdminPasswordHash,
      isBlocked: false,
    },
    create: {
      email: adminEmail,
      phone: '+998900000001',
      passwordHash: superAdminPasswordHash,
      name: 'Восилхожа Саидаминов',
      role: Role.ADMIN,
      adminRole: AdminRole.SUPER_ADMIN,
      verified: true,
    },
  });

  // Пользовательские аккаунты никогда не удаляются во время seed/deploy.

  // ─── 2. Настройки сайта (singleton) ────
  console.log('Ensuring SiteSettings singleton exists...');

  await prisma.siteSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      maintenanceMode: false,
      maintenanceMessage: 'Сайт временно недоступен. Мы проводим технические работы. Попробуйте позже.',
      siteName: 'AVERON',
      contactEmail: 'support@averon.uz',
      contactPhone: '+998 71 200-00-00',
      googleAuthEnabled: true,
      autoModerationEnabled: false,
      maxImagesPerListing: 10,
      updatedById: superAdmin.id,
    },
  });

  // ─── 3. Стартовые секции конструктора (создаются ТОЛЬКО если секций ещё нет) ──
  const existingSectionsCount = await prisma.pageSection.count({
    where: { pageKey: 'home' },
  });

  if (existingSectionsCount === 0) {
    console.log('Creating initial default PageSections for Home page...');

    const defaultHomeSections = [
      {
        pageKey: 'home',
        sectionType: 'HERO_SEARCH',
        title: 'Главный баннер с поиском',
        order: 0,
        isVisible: true,
        content: {
          title: 'Аренда жилья в Узбекистане без посредников',
          subtitle: 'Найдите идеальную квартиру, дом или комнату напрямую от собственников по всему Узбекистану',
          showSearch: true,
          searchPlaceholder: 'Район, метро, улица или город...',
          quickFilters: [
            { label: 'Студии', href: '/catalog?type_apartments=studio' },
            { label: '1-комнатные', href: '/catalog?rooms=1' },
            { label: 'Дома и участки', href: '/catalog?type=house' },
            { label: 'Возле метро', href: '/catalog?near_metro=true' },
            { label: 'Без комиссии', href: '/catalog?commission=false' },
          ],
        },
      },
      {
        pageKey: 'home',
        sectionType: 'BENEFITS',
        title: 'Честные преимущества',
        order: 1,
        isVisible: true,
        content: {
          title: 'Почему выбирают ijarauz',
          items: [
            {
              title: 'Прямой контакт с собственниками',
              text: 'Все объявления проходят модерацию. Никаких скрытых комиссий риелторов.',
              icon: 'ShieldCheck',
            },
            {
              title: 'Удобный поиск по карте',
              text: 'Выбирайте жилье рядом с работой, учебой или станциями метро на интерактивной карте.',
              icon: 'Map',
            },
            {
              title: 'Безопасное общение',
              text: 'Встроенный чат с проверкой истории и защитой от спама и мошенников.',
              icon: 'MessagesSquare',
            },
          ],
        },
      },
      {
        pageKey: 'home',
        sectionType: 'POPULAR_LISTINGS',
        title: 'Популярные предложения',
        order: 2,
        isVisible: true,
        content: {
          title: 'Популярные объявления',
          subtitle: 'Свежие предложения аренды',
          viewAllText: 'Смотреть все',
          limit: 6,
        },
      },
      {
        pageKey: 'home',
        sectionType: 'CTA_BANNER',
        title: 'Баннер сдачи жилья',
        order: 3,
        isVisible: true,
        content: {
          title: 'Сдайте жильё выгодно и быстро',
          text: 'Разместите объявление бесплатно за 2 минуты и найдите надежных арендаторов уже сегодня',
          buttonText: 'Разместить объявление',
          buttonLink: '/add-listing',
        },
      },
      {
        pageKey: 'home',
        sectionType: 'CATEGORIES',
        title: 'Категории жилья',
        order: 4,
        isVisible: true,
        content: {
          title: 'Категории жилья',
          categories: [
            { name: 'Посуточно', icon: 'Key', href: '/catalog?rental_type=daily' },
            { name: 'Новостройки', icon: 'Building2', href: '/catalog?building_type=new' },
            { name: 'Элитные', icon: 'Sparkles', href: '/catalog?class=elite' },
            { name: 'Для студентов', icon: 'Home', href: '/catalog?for_whom=students' },
            { name: 'Долгосрочно', icon: 'Building', href: '/catalog?rental_type=long' },
            { name: 'Студии', icon: 'Home', href: '/catalog?type_apartments=studio' },
          ],
        },
      },
    ];

    for (const sec of defaultHomeSections) {
      await prisma.pageSection.create({
        data: {
          ...sec,
          updatedById: superAdmin.id,
        },
      });
    }
  } else {
    console.log(`Skipping PageSections creation (${existingSectionsCount} sections already exist).`);
  }

  // ─── 4. Начальные промокоды (если не созданы) ─────────────────────────────────
  console.log('Ensuring initial Promo Codes exist...');
  await prisma.promoCode.upsert({
    where: { code: 'WELCOME10' },
    update: {},
    create: {
      code: 'WELCOME10',
      discountPercent: 10,
      maxUses: 1000,
      isActive: true,
    },
  });

  await prisma.promoCode.upsert({
    where: { code: 'VIP20' },
    update: {},
    create: {
      code: 'VIP20',
      discountPercent: 20,
      maxUses: 500,
      isActive: true,
    },
  });

  // ─── 5. Начальный арендодатель и объявления (если база пустая) ───────────────
  const existingListingsCount = await prisma.listing.count();
  if (existingListingsCount === 0) {
    console.log('Creating sample verified landlord and initial active listings...');

    const landlord = await prisma.user.upsert({
      where: { email: 'landlord@ijarauz.uz' },
      update: {},
      create: {
        email: 'landlord@ijarauz.uz',
        phone: '+998901234567',
        passwordHash: superAdminPasswordHash,
        name: 'Алишер Усманов',
        role: Role.LANDLORD,
        verified: true,
      },
    });

    const sampleListings = [
      {
        title: 'Светлая 2-комнатная квартира в центре',
        description: 'Отличная квартира с новым ремонтом, всей мебелью и бытовой техникой. В 5 минутах от метро Ойбек. Идеально для семьи.',
        price: 550,
        type: 'APARTMENT' as const,
        rooms: 2,
        area: 65,
        floor: 4,
        totalFloors: 9,
        lat: 41.3005,
        lng: 69.2785,
        city: 'Ташкент',
        district: 'Мирабадский район',
        address: 'ул. Афросиаб, д. 12',
        status: 'ACTIVE' as const,
        moderationStatus: 'APPROVED' as const,
        isVerified: true,
        isPromoted: true,
        promotionTier: 'TOP' as const,
        ownerId: landlord.id,
      },
      {
        title: 'Уютная студия возле метро Новза',
        description: 'Современная студия со всеми удобствами: кондиционер, стиральная машина, Wi-Fi. Чистый подъезд, тихий двор.',
        price: 380,
        type: 'APARTMENT' as const,
        rooms: 1,
        area: 42,
        floor: 3,
        totalFloors: 5,
        lat: 41.2855,
        lng: 69.2155,
        city: 'Ташкент',
        district: 'Чиланзарский район',
        address: 'проспект Бунёдкор, д. 45',
        status: 'ACTIVE' as const,
        moderationStatus: 'APPROVED' as const,
        isVerified: true,
        isPromoted: false,
        ownerId: landlord.id,
      },
      {
        title: 'Просторный дом в Самарканде',
        description: 'Большой благоустроенный дом с садом и гаражом. Все коммуникации подключены, тихий престижный район.',
        price: 700,
        type: 'HOUSE' as const,
        rooms: 4,
        area: 160,
        floor: 1,
        totalFloors: 2,
        lat: 39.6542,
        lng: 66.9597,
        city: 'Самарканд',
        district: 'Центральный район',
        address: 'ул. Регистан, д. 8',
        status: 'ACTIVE' as const,
        moderationStatus: 'APPROVED' as const,
        isVerified: true,
        isPromoted: true,
        promotionTier: 'URGENT' as const,
        ownerId: landlord.id,
      },
    ];

    for (const listing of sampleListings) {
      await prisma.listing.create({
        data: listing,
      });
    }
  }

  console.log('✅ Safe Seed completed successfully!');
  console.log('');
  console.log('--- Аккаунт администратора ---');
  console.log(`Email:    ${adminEmail}`);
  console.log(`Пароль:   [установлен из переменной SEED_ADMIN_PASSWORD]`);
  console.log(`Роль:     SUPER_ADMIN`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
