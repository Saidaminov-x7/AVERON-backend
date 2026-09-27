// apps/api/src/modules/listings/schemas.ts

import { z } from 'zod';
import { ListingType, ListingStatus, Amenity, PromotionTier, ReportReason } from '@prisma/client';

// Справочник городов и районов для валидации
const knownDistricts: Record<string, string[]> = {
  "Ташкент": ["Алмазарский район","Бектемирский район","Мирабадский район","Мирзо-Улугбекский район","Сергелийский район","Учтепинский район","Чиланзарский район","Шайхантахурский район","Юнусабадский район","Яккасарайский район","Яшнабадский район","Янгихаётский район"],
  "Нукус": ["Амударьинский район","Берунийский район","Бозатауский район","Канлыкульский район","Караузякский район","Кегейлийский район","Кунградский район","Муйнакский район","Нукусский район","Тахиаташский район","Тахтакупырский район","Турткульский район","Ходжейлийский район","Чимбайский район","Шуманайский район","Элликкалинский район"],
  "Андижан": ["Алтынкульский район","Андижанский район","Асакинский район","Балыкчинский район","Бозский район","Булакбашинский район","Джалалкудукский район","Избасканский район","Кургантепинский район","Мархаматский район","Пахтаабадский район","Улугнорский район","Ходжаабадский район","Шахриханский район"],
  "Бухара": ["Алатский район","Бухарский район","Вабкентский район","Гиждуванский район","Жондорский район","Каганский район","Каракульский район","Караулбазарский район","Пешкунский район","Ромитанский район","Шафирканский район"],
  "Джизак": ["Арнасайский район","Бахмальский район","Галляаральский район","Джизакский район","Дустликский район","Зааминский район","Зарбдарский район","Зафарабадский район","Мирзачульский район","Пахтакорский район","Фаришский район","Янгиабадский район"],
  "Карши": ["Гузарский район","Дехканабадский район","Камашинский район","Каршинский район","Касанский район","Касбийский район","Китабский район","Кукдалинский район","Миришкорский район","Мубарекский район","Нишанский район","Чиракчинский район","Шахрисабзский район","Яккабагский район"],
  "Навои": ["Канимехский район","Карманинский район","Кызылтепинский район","Навбахорский район","Нуратинский район","Тамдынский район","Учкудукский район","Хатырчинский район"],
  "Наманган": ["Давлатабадский район","Касансайский район","Мингбулакский район","Наманганский район","Нарынский район","Папский район","Туракурганский район","Уйчинский район","Учкурганский район","Чартакский район","Чустский район","Янгикурганский район","Янги Наманганский район"],
  "Самарканд": ["Акдарьинский район","Булунгурский район","Джамбайский район","Иштыханский район","Каттакурганский район","Кошрабадский район","Нарпайский район","Нурабадский район","Пайарыкский район","Пастдаргомский район","Пахтачийский район","Самаркандский район","Тайлакский район","Ургутский район"],
  "Термез": ["Алтынсайский район","Ангорский район","Байсунский район","Бандиханский район","Денауский район","Джаркурганский район","Кизирикский район","Кумкурганский район","Музрабадский район","Сарыасийский район","Термезский район","Узунский район","Шерабадский район","Шурчинский район"],
  "Гулистан": ["Акалтынский район","Баяутский район","Гулистанский район","Мирзаабадский район","Сайхунабадский район","Сардобинский район","Сырдарьинский район","Хавастский район"],
  "Фергана": ["Алтыарыкский район","Багдадский район","Бешарыкский район","Бувайдинский район","Дангаринский район","Кувасайский район","Кувинский район","Коштепинский район","Риштанский район","Сохский район","Ташлакский район","Учкуприкский район","Ферганский район","Фуркатский район","Язъяванский район"],
  "Ургенч": ["Багатский район","Гурленский район","Кошкупырский район","Тупраккалинский район","Ургенчский район","Хазараспский район","Ханкинский район","Хивинский район","Шаватский район","Янгиарыкский район","Янгибазарский район"],
};

const createListingBaseSchema = z.object({
  title: z.string().min(5).max(200),
  description: z.string().min(20).max(5000),
  price: z.number().positive(),
  type: z.nativeEnum(ListingType),
  rooms: z.number().int().min(0).max(50),
  area: z.number().positive(),
  floor: z.number().int().optional(),
  totalFloors: z.number().int().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  city: z.string().min(2).max(100),
  district: z.string().min(2).max(100),
  address: z.string().max(300).optional(),
  amenities: z.array(z.nativeEnum(Amenity)).default([]),
});

export const createListingSchema = createListingBaseSchema.superRefine((value, ctx) => {
  const districts = knownDistricts[value.city];
  if (districts && !districts.includes(value.district)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['district'], message: 'Выберите район из списка для выбранного города' });
  }
  // Если город не известен, просто проверяем что район заполнен
  if (!districts && !value.district) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['district'], message: 'Район обязателен' });
  }
});

export type CreateListingDto = z.infer<typeof createListingSchema>;

export const updateListingSchema = createListingBaseSchema.partial().extend({
  status: z.nativeEnum(ListingStatus).optional(),
});

export type UpdateListingDto = z.infer<typeof updateListingSchema>;

export const listingsFilterSchema = z.object({
  city: z.string().optional(),
  district: z.string().optional(),
  type: z.nativeEnum(ListingType).optional(),
  status: z.nativeEnum(ListingStatus).optional(),
  minPrice: z.coerce.number().positive().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  minRooms: z.coerce.number().int().min(0).optional(),
  maxRooms: z.coerce.number().int().optional(),
  amenities: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(',') : undefined))
    .pipe(z.array(z.nativeEnum(Amenity)).optional()),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['price', 'createdAt', 'viewsCount', 'area']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListingsFilterDto = z.infer<typeof listingsFilterSchema>;

export const promoteListingSchema = z.object({
  tier: z.nativeEnum(PromotionTier).default(PromotionTier.BASIC),
  days: z.coerce.number().int().min(1).max(365).default(7),
});

export type PromoteListingDto = z.infer<typeof promoteListingSchema>;

export const reportListingSchema = z.object({
  reason: z.nativeEnum(ReportReason),
  comment: z.string().max(500).optional(),
});

export type ReportListingDto = z.infer<typeof reportListingSchema>;

export const estimatePriceSchema = z.object({
  city: z.string().min(2),
  district: z.string().optional(),
  rooms: z.coerce.number().int().min(0),
  area: z.coerce.number().positive(),
  type: z.string().default('APARTMENT'),
});

export type EstimatePriceDto = z.infer<typeof estimatePriceSchema>;
