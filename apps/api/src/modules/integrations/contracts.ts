export type ProductSourceProviderId = 'SOURCE_1688' | 'TAOBAO' | 'ALIBABA' | 'ALIEXPRESS' | 'PINDUODUO';

export interface ProductImportContract {
  sourceProvider: ProductSourceProviderId;
  sourceProductId: string;
  sourceUrl: string;
  sourceMetadata: Record<string, unknown>;
  deduplicationKey: string;
}

export interface ProductSourceProvider {
  readonly id: ProductSourceProviderId;
  isEnabled(): boolean;
  importProduct(sourceProductId: string): Promise<ProductImportContract>;
}

export type ShipmentStatus = 'PENDING' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED';

export interface ShippingAddress {
  recipientName: string;
  phone: string;
  countryCode: string;
  region: string;
  city: string;
  addressLine: string;
  postalCode?: string;
}

export interface ShippingQuote {
  deliveryCost: number;
  currency: 'UZS';
  estimatedDeliveryAt?: string;
  providerReference?: string;
}

export interface Shipment {
  id?: string;
  trackingNumber: string | null;
  status: ShipmentStatus;
  deliveryCost: number | null;
  providerReference: string | null;
}

export interface ShippingProvider {
  readonly id: string;
  isEnabled(): boolean;
  createShipment(orderId: string): Promise<Shipment>;
  getShipment(trackingNumber: string): Promise<Shipment>;
}

export interface IPostProvider extends ShippingProvider {
  readonly id: 'ipost';
  quote(address: ShippingAddress, weightGrams: number): Promise<ShippingQuote>;
}

export interface TelegramSecurityProvider {
  sendLoginCode(telegramId: string, code: string): Promise<void>;
}

export interface TelegramProductPublication {
  title: string;
  description: string;
  priceUzs: number;
  country: string;
  deliveryInfo: string;
  productUrl: string;
  mainImageUrl: string;
}

export interface TelegramProductPublisher {
  publish(product: TelegramProductPublication): Promise<void>;
}

export interface ExchangeRateProvider {
  getRate(baseCurrency: 'CNY', quoteCurrency: 'UZS'): Promise<number>;
}

export interface SmsProvider {
  send(phone: string, message: string): Promise<boolean>;
}

export type AveronDomainEvent =
  | { type: 'product.import.received'; importId: string; provider: string; occurredAt: string }
  | { type: 'product.import.approved'; importId: string; productId: string; actorId: string; occurredAt: string }
  | { type: 'product.import.rejected'; importId: string; actorId: string; reason?: string; occurredAt: string }
  | { type: 'product.published'; productId: string; actorId: string; occurredAt: string }
  | { type: 'product.approved'; productId: string; occurredAt: string }
  | { type: 'order.created'; orderId: string; occurredAt: string }
  | { type: 'order.status_changed'; orderId: string; status: string; occurredAt: string }
  | { type: 'shipment.created'; orderId: string; occurredAt: string }
  | { type: 'shipment.updated'; orderId: string; status: string; occurredAt: string };

export interface DomainEventPublisher {
  publish(event: AveronDomainEvent): Promise<void>;
}
