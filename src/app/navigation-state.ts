import { profilePositionKey } from './profile-requests';

export const tabs = ['/', '/rate', '/watchlist', '/library'] as const;
export type Tab = typeof tabs[number];
const base = 'http://navigation.local';
export function activeTab(pathname: string, params = new URLSearchParams()): Tab | null {
  if (params.getAll('from').length === 1 && params.get('from') === 'home' && params.has('movie_id') && (pathname === '/library' || pathname === '/rate')) return '/';
  if (pathname.startsWith('/preview/')) return '/';
  return tabs.find(tab => tab === pathname) ?? null;
}
export function listUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== base || !tabs.includes(url.pathname as Tab)) return null;
  if (activeTab(url.pathname, url.searchParams) === '/' && url.pathname !== '/') return '/';
  url.searchParams.delete('movie_id'); url.searchParams.delete('from'); url.hash = '';
  return url.pathname + url.search;
}
export function detailUrl(tab: '/library' | '/rate' | '/watchlist', id: number, home = false) {
  return `${tab}?movie_id=${id}${home ? '&from=home' : ''}`;
}
export function readSession<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(profilePositionKey(`navigation:v1:${key}`)) ?? 'null') ?? fallback; } catch { return fallback; }
}
export function writeSession(key: string, value: unknown) {
  try { sessionStorage.setItem(profilePositionKey(`navigation:v1:${key}`), JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
export function tabUrl(tab: Tab) {
  const saved = readSession<string>(`tab:${tab}`, tab);
  return typeof saved === 'string' && listUrl(saved) === saved && activeTab(new URL(saved, base).pathname) === tab ? saved : tab;
}
export function rememberPosition(url: string, id?: number) {
  const old = readSession<{ y: number; id?: number }>(`position:${url}`, { y: 0 });
  writeSession(`position:${url}`, { y: window.scrollY, id: id ?? old.id });
}
export function savedPosition(url: string) {
  const saved = readSession<{ y: number; id?: number } | null>(`position:${url}`, null);
  return saved && Number.isFinite(saved.y) && saved.y >= 0 ? saved : null;
}
