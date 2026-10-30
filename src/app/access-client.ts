const STORAGE_KEY = 'recommendme-access:v1';
let memoryToken: string | null = null;

export function saveAccess(token: string) {
  memoryToken = token;
  try { localStorage.setItem(STORAGE_KEY, token); } catch { /* This tab still works when storage is unavailable. */ }
}
export function clearAccess() {
  memoryToken = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
/** Never attach the bearer credential to another origin, redirects, or non-API URLs. */
export async function accessFetch(path: string, init: RequestInit = {}) {
  const target = new URL(path, window.location.origin);
  if (!path.startsWith('/api/') || path.startsWith('//') || /[\\#]/.test(path) ||
      target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) throw new Error('Invalid application request');
  const headers = new Headers(init.headers);
  let token = memoryToken;
  try { token = localStorage.getItem(STORAGE_KEY) ?? token; } catch {}
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else headers.delete('Authorization');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (response.status === 401) {
    clearAccess();
    window.dispatchEvent(new Event('recommendme-access-invalid'));
  }
  return response;
}
