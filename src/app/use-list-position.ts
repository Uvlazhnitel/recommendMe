'use client';
import { useEffect } from 'react';
import { rememberPosition, savedPosition } from './navigation-state';

export function useListPosition(url: string, ready: boolean, prefix: string, headingId: string) {
  useEffect(() => {
    if (!ready) return;
    const saved = savedPosition(url);
    const frame = requestAnimationFrame(() => {
      if (!saved) { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
      const card = saved.id ? document.getElementById(`${prefix}${saved.id}`) : null;
      (card ?? document.getElementById(headingId))?.focus({ preventScroll: true });
      window.scrollTo({ top: saved.y, behavior: 'instant' });
    });
    const scroll = () => rememberPosition(url);
    window.addEventListener('scroll', scroll, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', scroll); };
  }, [url, ready, prefix, headingId]);
}
