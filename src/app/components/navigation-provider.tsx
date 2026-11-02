'use client';

import { createContext, useCallback, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { activeTab, listUrl, rememberPosition, writeSession } from '../navigation-state';

type Guard = { dirty: boolean; busy: boolean; discard: () => void };
type Navigation = { registerGuard: (guard: Guard) => () => void; allow: () => boolean; back: (fallback: string) => void; push: (url: string) => void };
const Context = createContext<Navigation | null>(null);
const marker = '__recommendmeNavigation';
// The root-layout bootstrap registers before Next's own popstate listener.
declare global { interface Window { recommendmePopState?: (event: PopStateEvent) => void; recommendmePopStateReady?: boolean } }
type Entry = { index: number; previous?: string };
export function NavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter(), guard = useRef<Guard | null>(null);
  const registerGuard = useCallback((current: Guard) => {
    guard.current = current;
    return () => { if (guard.current === current) guard.current = null; };
  }, []);
  const allow = useCallback(() => {
    const current = guard.current;
    if (current?.busy) return false;
    if (current?.dirty) {
      if (!window.confirm('Есть несохранённые изменения. Уйти и сбросить их?')) return false;
      current.discard();
      // The same transition can trigger both a click and popstate before React commits.
      guard.current = { ...current, dirty: false };
    }
    return true;
  }, []);
  useLayoutEffect(() => {
    const history = window.history, push = history.pushState, replace = history.replaceState;
    let current: Entry = { ...history.state?.[marker], index: window.navigation?.currentEntry?.index ?? history.state?.[marker]?.index ?? 0 };
    replace.call(history, { ...history.state, [marker]: current }, '');
    function remember(position = false) {
      const url = location.pathname + location.search, list = listUrl(url);
      if (!list) return;
      const tab = activeTab(location.pathname, new URLSearchParams(location.search));
      if (tab) writeSession(`tab:${tab}`, list);
      if (position && !new URLSearchParams(location.search).has('movie_id')) rememberPosition(list);
    }
    remember();
    history.pushState = function (data, unused, url) {
      remember(true);
      // Hydration may replace the initial Next.js state before the first push.
      // Annotate the source too, so a legacy popstate always has a return index.
      replace.call(history, { ...history.state, [marker]: current }, '');
      const previous = location.pathname + location.search;
      current = { index: current.index + 1, previous };
      push.call(history, { ...data, [marker]: current }, unused, url);
      remember();
    };
    history.replaceState = function (data, unused, url) {
      // Next.js may restore a previously captured history state. Keep our current entry.
      replace.call(history, { ...data, [marker]: current }, unused, url);
      remember();
    };
    let restoring = false;
    const pop = (event: PopStateEvent) => {
      const next: Entry | undefined = event.state?.[marker];
      if (restoring) { restoring = false; return; }
      if (!next) return; // Cross-document entries are covered by beforeunload.
      if (!allow()) {
        event.stopImmediatePropagation();
        restoring = true; history.go(current.index - next.index);
        return;
      }
      current = next;
      remember();
    };
    // Next 16 can restore a cached tree before popstate. Cancel supported
    // traversals at the Navigation API event, while the current editor is active.
    const traverse = (event: NavigateEvent) => {
      if (event.navigationType !== 'traverse' || !event.destination.sameDocument || !event.cancelable) return;
      if (!allow()) { event.preventDefault(); return; }
      remember(true);
      const previous = window.navigation.entries().find(entry => entry.index === event.destination.index - 1 && entry.sameDocument);
      const url = previous?.url ? new URL(previous.url) : null;
      current = { index: event.destination.index, previous: url?.origin === location.origin ? url.pathname + url.search : undefined };
    };
    window.navigation?.addEventListener('navigate', traverse, true);
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      if (!allow()) { event.preventDefault(); event.stopPropagation(); return; }
      const id = Number(url.searchParams.get('movie_id'));
      const source = listUrl(location.pathname + location.search);
      if (source && !new URLSearchParams(location.search).has('movie_id') && Number.isSafeInteger(id) && id > 0) rememberPosition(source, id);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (guard.current?.dirty || guard.current?.busy) { event.preventDefault(); event.returnValue = ''; }
    };
    window.recommendmePopState = pop;
    if (!window.recommendmePopStateReady) window.addEventListener('popstate', pop, true);
    document.addEventListener('click', click, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      if (window.recommendmePopState === pop) delete window.recommendmePopState;
      window.navigation?.removeEventListener('navigate', traverse, true);
      history.pushState = push; history.replaceState = replace;
      window.removeEventListener('popstate', pop, true); document.removeEventListener('click', click, true); window.removeEventListener('beforeunload', unload);
    };
  }, [allow]);
  function back(fallback: string) {
    if (!allow()) return;
    if (window.history.state?.[marker]?.previous === fallback) router.back();
    else router.replace(fallback, { scroll: false });
  }
  return <Context value={{ registerGuard, allow, back, push: url => { if (allow()) router.push(url, { scroll: false }); } }}>{children}</Context>;
}
export function useAppNavigation() {
  const value = useContext(Context);
  return value ?? { registerGuard: () => () => {}, allow: () => true, back: (url: string) => window.location.assign(url), push: (url: string) => window.location.assign(url) };
}
export function useNavigationGuard(dirty: boolean, isBusy: () => boolean, discard: () => void) {
  const register = useContext(Context)?.registerGuard;
  useLayoutEffect(() => register?.({ dirty, get busy() { return isBusy(); }, discard }), [register, dirty, isBusy, discard]);
}
