export function isSecureRequest(
  protocol: string,
  forwardedProtocol: string | string[] | undefined,
  railwayEnvironmentId?: string,
): boolean {
  if (protocol === 'https') return true;
  if (!railwayEnvironmentId?.trim()) return false;

  const forwarded = Array.isArray(forwardedProtocol)
    ? forwardedProtocol[0]
    : forwardedProtocol?.split(',')[0];

  return forwarded?.trim().toLowerCase() === 'https';
}
