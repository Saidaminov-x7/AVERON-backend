// packages/shared-types/src/index.ts

/**
 * Роли пользователей платформы
 */
export enum Role {
  USER = 'USER',
  LANDLORD = 'LANDLORD',
  ADMIN = 'ADMIN',
}

/**
 * Типы недвижимости
 */
export enum ListingType {
  APARTMENT = 'APARTMENT',
  HOUSE = 'HOUSE',
  ROOM = 'ROOM',
  COMMERCIAL = 'COMMERCIAL',
  LAND = 'LAND',
}

/**
 * Статусы объявлений
 */
export enum ListingStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
  DELETED = 'DELETED',
}

/**
 * Уровни продвижения (VIP/Boost)
 */
export enum PromotionTier {
  BASIC = 'BASIC',
  TOP = 'TOP',
  URGENT = 'URGENT',
}

/**
 * Причины жалоб на объявления
 */
export enum ReportReason {
  SCAM = 'SCAM',
  ALREADY_RENTED = 'ALREADY_RENTED',
  WRONG_PRICE = 'WRONG_PRICE',
  WRONG_PHOTOS = 'WRONG_PHOTOS',
  DUPLICATE = 'DUPLICATE',
  OTHER = 'OTHER',
}

/**
 * Статусы обработки жалоб
 */
export enum ReportStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

/**
 * Удобства недвижимости
 */
export enum Amenity {
  WIFI = 'WIFI',
  PARKING = 'PARKING',
  ELEVATOR = 'ELEVATOR',
  AIR_CONDITIONING = 'AIR_CONDITIONING',
  HEATING = 'HEATING',
  BALCONY = 'BALCONY',
  PETS_ALLOWED = 'PETS_ALLOWED',
  SECURITY = 'SECURITY',
  FURNITURE = 'FURNITURE',
  KITCHEN = 'KITCHEN',
  WASHING_MACHINE = 'WASHING_MACHINE',
  GYM = 'GYM',
  POOL = 'POOL',
  SAUNA = 'SAUNA',
}

/**
 * Статус прочтения сообщений
 */
export enum MessageReadStatus {
  DELIVERED = 'DELIVERED',
  READ = 'READ',
}

/**
 * Базовые интерфейсы сущностей
 */
export interface UserProfile {
  id: string;
  email: string;
  phone: string;
  name: string;
  avatar?: string | null;
  role: Role;
  verified: boolean;
  createdAt: string;
}

export interface MediaItem {
  id: string;
  url: string;
  mimeType: string;
  size?: number;
  width?: number | null;
  height?: number | null;
}

export interface ListingItem {
  id: string;
  ownerId: string;
  owner?: {
    id: string;
    name: string;
    avatar?: string | null;
    phone?: string;
  };
  title: string;
  description: string;
  price: number | string;
  type: ListingType;
  rooms: number;
  area: number | string;
  floor?: number | null;
  totalFloors?: number | null;
  lat?: number | null;
  lng?: number | null;
  city: string;
  district: string;
  address?: string | null;
  amenities: Amenity[];
  images?: MediaItem[];
  status: ListingStatus;
  isPromoted?: boolean;
  promotedUntil?: string | null;
  promotionTier?: PromotionTier | null;
  isVerified?: boolean;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  viewsCount: number;
  createdAt: string;
  updatedAt?: string;
  _count?: {
    favorites: number;
  };
}

/**
 * Пагинация
 */
export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  items: T[];
  meta: PaginationMeta;
}

/**
 * DTO для авторизации
 */
export interface AuthResponse {
  accessToken: string;
  user: UserProfile;
}

export interface RegisterRequest {
  email: string;
  phone: string;
  password: string;
  name: string;
  role?: Role;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * DTO для объявлений
 */
export interface CreateListingRequest {
  title: string;
  description: string;
  price: number;
  type: ListingType;
  rooms: number;
  area: number;
  floor?: number;
  totalFloors?: number;
  lat?: number;
  lng?: number;
  city: string;
  district: string;
  address?: string;
  amenities?: Amenity[];
}

export type UpdateListingRequest = Partial<CreateListingRequest> & {
  status?: ListingStatus;
};

export interface ListingFilterQuery {
  city?: string;
  district?: string;
  type?: ListingType;
  status?: ListingStatus;
  minPrice?: number;
  maxPrice?: number;
  minRooms?: number;
  maxRooms?: number;
  amenities?: string;
  page?: number;
  limit?: number;
  sortBy?: 'price' | 'createdAt' | 'viewsCount' | 'area';
  sortOrder?: 'asc' | 'desc';
}

/**
 * DTO для AI-чата
 */
export interface AISessionItem {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count?: {
    messages: number;
  };
}

export interface AIChatMessageItem {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string;
  timestamp: string;
}

export interface SendAIMessageRequest {
  message: string;
  sessionId?: string;
  model?: string;
}

export interface SendAIMessageResponse {
  sessionId: string;
  response: string;
  timestamp: string;
}

export * from './sections';
