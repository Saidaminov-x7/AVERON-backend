// packages/shared-types/src/sections.ts
// ЕДИНЫЙ источник правды по структуре content для всех типов секций.
// Импортируется и фронтендом, и админкой, и бэкендом (через shared-types).

export type SectionType =
  | 'HERO_SEARCH'
  | 'BENEFITS'
  | 'POPULAR_LISTINGS'
  | 'CTA_BANNER'
  | 'CATEGORIES'
  | 'TEXT_BLOCK'
  | 'CUSTOM_HTML'
  | 'TEAM_MEMBERS'
  | 'FAQ_ACCORDION'
  | 'CONTACT_INFO'
  | 'PLATFORM_STATS';

export interface QuickFilter {
  label: string;
  href: string;
}

export interface HeroSearchContent {
  title: string;
  subtitle: string;
  showSearch: boolean;
  searchPlaceholder: string;
  badgeText?: string;
  quickFilters?: QuickFilter[];
}

export interface BenefitItem {
  icon?: string; // имя иконки lucide-react, например "ShieldCheck"
  title: string;
  text: string;
}
export interface BenefitsContent {
  title: string;
  items: BenefitItem[];
}

export interface PopularListingsContent {
  title: string;
  subtitle?: string;
  viewAllText: string;
  limit: number;
}

export interface CtaBannerContent {
  title: string;
  text: string;
  buttonText: string;
  buttonLink: string;
}

export interface CategoryItem {
  name: string;
  icon: string; // имя иконки lucide-react
  href: string;
}
export interface CategoriesContent {
  title: string;
  categories: CategoryItem[];
}

export interface TextBlockContent {
  title?: string;
  subtitle?: string;
  text: string;
  align?: 'left' | 'center' | 'right';
}

export interface TeamMember {
  name: string;
  role: string;
  photoUrl?: string;
}
export interface TeamMembersContent {
  title: string;
  members: TeamMember[];
}

export interface FaqItem {
  question: string;
  answer: string;
}
export interface FaqAccordionContent {
  title: string;
  items: FaqItem[];
}

export interface ContactInfoContent {
  title: string;
  email?: string;
  phone?: string;
  address?: string;
  workingHours?: string;
  socials?: { telegram?: string; instagram?: string };
}

export interface PlatformStatsContent {
  title: string;
}

export type SectionContentMap = {
  HERO_SEARCH: HeroSearchContent;
  BENEFITS: BenefitsContent;
  POPULAR_LISTINGS: PopularListingsContent;
  CTA_BANNER: CtaBannerContent;
  CATEGORIES: CategoriesContent;
  TEXT_BLOCK: TextBlockContent;
  CUSTOM_HTML: TextBlockContent;
  TEAM_MEMBERS: TeamMembersContent;
  FAQ_ACCORDION: FaqAccordionContent;
  CONTACT_INFO: ContactInfoContent;
  PLATFORM_STATS: PlatformStatsContent;
};

export interface LocalizedContent<T> {
  ru: T;
  uz: T;
  en: T;
}

// Метаданные для UI конструктора (лейблы, иконки, дефолты) — используются только в админке,
// но лежат тут же, чтобы фронт и админка не расходились по списку типов.
export const SECTION_META: Record<
  SectionType,
  { label: string; icon: string; desc: string; defaultTitle: string }
> = {
  HERO_SEARCH: {
    label: 'Поисковая строка / Главный баннер',
    icon: 'Search',
    desc: 'Главный заголовок, подзаголовок, поле поиска и быстрые фильтры',
    defaultTitle: 'Главный баннер с поиском',
  },
  BENEFITS: {
    label: 'Преимущества / Особенности',
    icon: 'Sparkles',
    desc: 'Карточки с иконками, заголовками и описанием преимуществ',
    defaultTitle: 'Преимущества',
  },
  POPULAR_LISTINGS: {
    label: 'Популярные / Рекомендуемые объявления',
    icon: 'Flame',
    desc: 'Сетка популярных или рекомендованных объявлений из базы данных',
    defaultTitle: 'Популярные объявления',
  },
  CTA_BANNER: {
    label: 'Призыв к действию (CTA Баннер)',
    icon: 'Megaphone',
    desc: 'Баннер с заголовком, текстом и кнопкой перехода',
    defaultTitle: 'Баннер размещения',
  },
  CATEGORIES: {
    label: 'Категории жилья',
    icon: 'Tag',
    desc: 'Список категорий (посуточно, новостройки, студентам, комнаты)',
    defaultTitle: 'Категории жилья',
  },
  TEXT_BLOCK: {
    label: 'Текстовый блок / Описание',
    icon: 'FileText',
    desc: 'Свободный текстовый контент с заголовком, подзаголовком и форматированным текстом',
    defaultTitle: 'Информация',
  },
  TEAM_MEMBERS: {
    label: 'Наша команда / Эксперты',
    icon: 'Users',
    desc: 'Список членов команды с именами, ролями и фото',
    defaultTitle: 'Наша команда',
  },
  FAQ_ACCORDION: {
    label: 'Часто задаваемые вопросы (FAQ)',
    icon: 'HelpCircle',
    desc: 'Список вопросов и раскрывающихся ответов',
    defaultTitle: 'Вопросы и ответы',
  },
  CONTACT_INFO: {
    label: 'Контакты и обратная связь',
    icon: 'Phone',
    desc: 'Email, телефон, адрес, время работы и ссылки',
    defaultTitle: 'Контакты',
  },
  CUSTOM_HTML: {
    label: 'Произвольный контент / Markdown',
    icon: 'FileCode',
    desc: 'Универсальный блок с форматированным текстом или Markdown',
    defaultTitle: 'Дополнительный блок',
  },
  PLATFORM_STATS: {
    label: 'Статистика платформы',
    icon: 'BarChart3',
    desc: 'Автоматические цифры: объявления, пользователи, города, просмотры',
    defaultTitle: 'Статистика',
  },
};

// Дефолтный контент для каждого типа — используется и при создании секции в админке,
// и как fallback на фронтенде, если content пустой.
export const SECTION_DEFAULTS: SectionContentMap = {
  HERO_SEARCH: {
    title: 'Аренда жилья в Узбекистане без посредников',
    subtitle: 'Найдите идеальную квартиру, дом или комнату напрямую от собственников',
    showSearch: true,
    searchPlaceholder: 'Район, метро, улица или город...',
    badgeText: '✨ Проверенные собственники',
    quickFilters: [
      { label: 'Студии', href: '/catalog?type_apartments=studio' },
      { label: '1-комнатные', href: '/catalog?rooms=1' },
    ],
  },
  BENEFITS: {
    title: 'Почему выбирают ijarauz',
    items: [
      { icon: 'ShieldCheck', title: 'Прямой контакт с собственниками', text: 'Все объявления проходят модерацию. Никаких скрытых комиссий риелторов.' },
      { icon: 'Map', title: 'Удобный поиск по карте', text: 'Выбирайте жильё рядом с работой, учёбой или станциями метро.' },
      { icon: 'MessagesSquare', title: 'Безопасное общение', text: 'Встроенный чат с проверкой истории и защитой от спама и мошенников.' },
    ],
  },
  POPULAR_LISTINGS: {
    title: 'Популярные предложения',
    subtitle: 'Свежие проверенные варианты аренды',
    viewAllText: 'Смотреть все',
    limit: 6,
  },
  CTA_BANNER: {
    title: 'Сдайте жильё выгодно и быстро',
    text: 'Разместите объявление бесплатно за 2 минуты и найдите надёжных арендаторов уже сегодня',
    buttonText: 'Разместить объявление',
    buttonLink: '/add-listing',
  },
  CATEGORIES: {
    title: 'Категории недвижимости',
    categories: [
      { name: 'Посуточно', icon: 'Key', href: '/catalog?rental_type=daily' },
      { name: 'Новостройки', icon: 'Building2', href: '/catalog?building_type=new' },
      { name: 'Элитные', icon: 'Sparkles', href: '/catalog?class=elite' },
      { name: 'Для студентов', icon: 'Home', href: '/catalog?for_whom=students' },
      { name: 'Долгосрочно', icon: 'Home', href: '/catalog?rental_type=long' },
      { name: 'Студии', icon: 'Building', href: '/catalog?type_apartments=studio' },
    ],
  },
  TEXT_BLOCK: {
    title: 'О нашем сервисе',
    text: 'Ijarauz — это современная национальная платформа аренды жилой и коммерческой недвижимости в Узбекистане.',
    align: 'left',
  },
  CUSTOM_HTML: {
    title: 'Дополнительный блок',
    text: 'Текст блока.',
    align: 'left',
  },
  TEAM_MEMBERS: {
    title: 'Наша команда',
    members: [{ name: 'Иван Иванов', role: 'Основатель' }],
  },
  FAQ_ACCORDION: {
    title: 'Часто задаваемые вопросы',
    items: [
      { question: 'Как разместить объявление?', answer: 'Нажмите кнопку «Разместить объявление» в верхнем меню, заполните данные о квартире и прикрепите фотографии.' },
      { question: 'Берётся ли комиссия с арендаторов?', answer: 'Нет! Ijarauz соединяет арендаторов напрямую с проверенными собственниками без комиссий.' },
      { question: 'Как связаться с поддержкой?', answer: 'Вы можете написать нам через Telegram-бота или на email support@ijarauz.uz.' },
    ],
  },
  CONTACT_INFO: {
    title: 'Контакты',
    email: 'support@ijarauz.uz',
    phone: '+998 71 200-00-00',
    address: 'г. Ташкент, Узбекистан',
    workingHours: 'Пн–Пт, 9:00–18:00',
  },
  PLATFORM_STATS: {
    title: 'Ijarauz в цифрах',
  },
};
