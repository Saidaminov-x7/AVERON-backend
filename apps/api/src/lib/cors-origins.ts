const trustedStorefrontOrigins = [
  'https://averon.uz',
  'https://averon-frontend-three.vercel.app',
];

export function createCorsOriginAllowlist(configuredOrigins: string[]): Set<string> {
  return new Set([...configuredOrigins, ...trustedStorefrontOrigins]);
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return !origin || allowedOrigins.has(origin);
}
