import { featureFlags } from '../features/feature-flags';

export function publicProductDto<T extends {
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  preorderEstimatedAt: Date | null;
  variants?: Array<{ stock: number; active: boolean }>;
  fittingRoomAssets?: Array<{ id: string }>;
}>(product: T) {
  const {
    preorderEnabled,
    preorderLimit,
    preorderReserved,
    preorderEstimatedAt,
    ...publicProduct
  } = product;
  const preorderAvailable = preorderEnabled ? Math.max(0, preorderLimit - preorderReserved) : 0;
  return {
    ...publicProduct,
    fittingRoomAvailable: featureFlags.isEnabled('FITTING_ROOM') && (product.fittingRoomAssets?.length ?? 0) > 0,
    availability: {
      inStock: product.variants
        ? product.variants.some((variant) => variant.active && variant.stock > 0)
        : product.stock > 0,
      preorderEligible: preorderAvailable > 0,
      preorderAvailable,
      estimatedAvailableAt: preorderEnabled ? preorderEstimatedAt : null,
    },
  };
}
