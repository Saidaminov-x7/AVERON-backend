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

export interface Shipment {
  trackingNumber: string | null;
  status: 'PENDING' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED';
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
  | { type: 'product.approved'; productId: string; occurredAt: string }
  | { type: 'order.created'; orderId: string; occurredAt: string }
  | { type: 'order.status_changed'; orderId: string; status: string; occurredAt: string }
  | { type: 'shipment.updated'; orderId: string; status: string; occurredAt: string };

export interface DomainEventPublisher {
  publish(event: AveronDomainEvent): Promise<void>;
}
