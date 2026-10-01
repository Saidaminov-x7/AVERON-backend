const secretAssignment = /\b(password|secret|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi;
const urlWithQuery = /https?:\/\/[^\s"'<>?#]+(?:\?[^\s"'<>#]*)?(?:#[^\s"'<>]*)?/gi;
const bearerCredential = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function sanitizeErrorText(value: string): string {
  return value
    .replace(urlWithQuery, (url) => url.split(/[?#]/, 1)[0] ?? url)
    .replace(secretAssignment, '$1$2[redacted]')
    .replace(bearerCredential, 'Bearer [redacted]')
    .replace(jwt, '[redacted JWT]');
}

export function sanitizeErrorReportUrl(value: string): string {
  try {
    const url = new URL(value, 'https://averon.invalid');
    if (!['http:', 'https:'].includes(url.protocol)) return '[invalid-url]';
    const path = `${url.origin === 'https://averon.invalid' ? '' : url.origin}${url.pathname}`;
    return path.slice(0, 500);
  } catch {
    return '[invalid-url]';
  }
}
