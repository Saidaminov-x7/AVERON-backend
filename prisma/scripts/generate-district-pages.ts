// prisma/scripts/generate-district-pages.ts
// Скрипт программной генерации SEO-лендингов по районам Узбекистана

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DISTRICTS_DATA = [
  // Ташкент
  { city: 'Ташкент', district: 'Юнусабадский район', slug: 'arenda-tashkent-yunusabad', title: 'Аренда квартир в Юнусабадском районе Ташкента' },
  { city: 'Ташкент', district: 'Чиланзарский район', slug: 'arenda-tashkent-chilanzer', title: 'Аренда квартир в Чиланзарском районе Ташкента' },
  { city: 'Ташкент', district: 'Мирабадский район', slug: 'arenda-tashkent-mirabad', title: 'Аренда квартир в Мирабадском районе Ташкента' },
  { city: 'Ташкент', district: 'Яккасарайский район', slug: 'arenda-tashkent-yakkasaray', title: 'Аренда квартир в Яккасарайском районе Ташкента' },
  { city: 'Ташкент', district: 'Мирзо-Улугбекский район', slug: 'arenda-tashkent-mirzo-ulugbek', title: 'Аренда квартир в Мирзо-Улугбекском районе Ташкента' },
  { city: 'Ташкент', district: 'Шайхантахурский район', slug: 'arenda-tashkent-shayhantahur', title: 'Аренда квартир в Шайхантахурском районе Ташкента' },
  { city: 'Ташкент', district: 'Алмазарский район', slug: 'arenda-tashkent-almazar', title: 'Аренда квартир в Алмазарском районе Ташкента' },
  { city: 'Ташкент', district: 'Сергелийский район', slug: 'arenda-tashkent-sergeli', title: 'Аренда квартир в Сергелийском районе Ташкента' },
  { city: 'Ташкент', district: 'Учтепинский район', slug: 'arenda-tashkent-uchtepa', title: 'Аренда квартир в Учтепинском районе Ташкента' },
  { city: 'Ташкент', district: 'Яшнабадский район', slug: 'arenda-tashkent-yashnabad', title: 'Аренда квартир в Яшнабадском районе Ташкента' },
  // Самарканд
  { city: 'Самарканд', district: 'Центральный район', slug: 'arenda-samarkand-center', title: 'Аренда недвижимости в центре Самарканда' },
  // Бухара
  { city: 'Бухара', district: 'Центральный район', slug: 'arenda-bukhara-center', title: 'Аренда квартир и домов в Бухаре' },
  // Фергана
  { city: 'Фергана', district: 'Центральный район', slug: 'arenda-fergana-center', title: 'Аренда жилья в Фергане' },
];

export async function generateDistrictPages() {
  console.log('🚀 Generating Programmatic SEO District Pages...');
  let created = 0;

  for (const item of DISTRICTS_DATA) {
    const existing = await prisma.page.findUnique({ where: { slug: item.slug } });
    if (!existing) {
      const content = `## Снять жильё: ${item.district}, ${item.city}

Ищете проверенную квартиру или дом для долгосрочной или посуточной аренды в ${item.district} города ${item.city}?

На платформе **Ijarauz** вы найдёте актуальные объявления от собственников с честными фотографиями, подтверждёнными ценами и возможностью безопасной онлайн-записи на просмотр.

### Преимущества аренды в этом районе:
- Развитая транспортная инфраструктура и доступность метро / остановок
- Близость к супермаркетам, школам, университетам и паркам
- Большой выбор 1-, 2- и 3-комнатных квартир со свежим ремонтом
- Отсутствие скрытых комиссий риелторов

Пользуйтесь фильтрами каталога Ijarauz, сохраняйте поиски и находите идеальное жильё напрямую!`;

      await prisma.page.create({
        data: {
          slug: item.slug,
          title: item.title,
          content,
          locale: 'ru',
          isPublished: true,
        },
      });
      created++;
    }
  }

  console.log(`✅ Successfully generated ${created} new SEO district pages.`);
}

if (require.main === module) {
  generateDistrictPages()
    .then(() => prisma.$disconnect())
    .catch((e) => {
      console.error(e);
      prisma.$disconnect();
      process.exit(1);
    });
}
