export function publicProductDto<T extends {
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  preorderEstimatedAt: Date | null;
  variants?: Array<{ stock: number; active: boolean }>;
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
