import { describe, expect, it } from 'vitest';
import { createCorsOriginAllowlist, isCorsOriginAllowed } from './cors-origins';

describe('CORS origin allowlist', () => {
  const origins = createCorsOriginAllowlist(['https://averon-admin-panel.vercel.app']);

  it('allows explicitly trusted production storefront origins and configured admin origins', () => {
    expect(isCorsOriginAllowed('https://averon.uz', origins)).toBe(true);
    expect(isCorsOriginAllowed('https://averon-frontend-three.vercel.app', origins)).toBe(true);
    expect(isCorsOriginAllowed('https://averon-admin-panel.vercel.app', origins)).toBe(true);
    expect(isCorsOriginAllowed(undefined, origins)).toBe(true);
  });

  it('does not broaden the allowlist to arbitrary Vercel previews or lookalikes', () => {
    expect(isCorsOriginAllowed('https://averon-frontend-three-git-preview.vercel.app', origins)).toBe(false);
    expect(isCorsOriginAllowed('https://averon.uz.attacker.example', origins)).toBe(false);
  });
});
