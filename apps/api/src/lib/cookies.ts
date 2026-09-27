import { config } from '../config';

/**
 * Cross-site cookies (admin-panel.vercel.app → api.railway.app) require
 * SameSite=None and Secure. Lax cookies are dropped on cross-origin XHR.
 */
export function refreshCookieOptions() {
  const isProd = config.NODE_ENV === 'production';
  return {
    httpOnly: true as const,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  };
}
