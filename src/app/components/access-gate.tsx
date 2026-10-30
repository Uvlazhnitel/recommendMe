'use client';

import { useEffect, useState } from 'react';
import { accessFetch, clearAccess, saveAccess } from '../access-client';

// Deduplicate the fragment exchange across Strict Mode effect replays.
let bootstrap: Promise<boolean> | null = null;
async function initializeAccess() {
  const fragment = window.location.pathname === '/access' ? window.location.hash : '';
  if (fragment) window.history.replaceState(null, '', '/access');
  const key = new URLSearchParams(fragment.slice(1)).get('key');
  if (key !== null) {
    clearAccess();
    const response = await fetch('/api/access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401) return false;
      throw Error();
    }
    const body = await response.json();
    if (typeof body.token !== 'string') throw Error();
    saveAccess(body.token);
  }
  const status = await accessFetch('/api/access');
  if (status.status === 401) return false;
  if (!status.ok) throw Error();
  if (window.location.pathname === '/access') window.history.replaceState(null, '', '/');
  return true;
}

export function AccessGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'required' | 'error'>('loading');
  useEffect(() => {
    let disposed = false;
    const invalid = () => { bootstrap = null; setState('required'); };
    const storage = (event: StorageEvent) => { if (event.key === 'recommendme-access:v1') window.location.reload(); };
    window.addEventListener('recommendme-access-invalid', invalid);
    window.addEventListener('storage', storage);
    bootstrap ??= initializeAccess();
    void bootstrap.then(ok => { if (!disposed) setState(ok ? 'ready' : 'required'); })
      .catch(() => { bootstrap = null; if (!disposed) setState('error'); });
    return () => { disposed = true; window.removeEventListener('recommendme-access-invalid', invalid); window.removeEventListener('storage', storage); };
  }, []);
  if (state === 'ready') return children;
  return <main id="main" className="app-main"><section className="profile-chooser">
    <h1>{state === 'loading' ? 'Проверяем доступ…' : state === 'error' ? 'Не удалось проверить доступ' : 'Вход по семейной ссылке'}</h1>
    <p role={state === 'error' ? 'alert' : 'status'}>{state === 'loading' ? 'Приложение скоро откроется.' : state === 'error'
      ? 'Проверьте соединение и повторно откройте семейную ссылку. Если ошибка повторится, сообщите владельцу приложения.'
      : 'Откройте секретную ссылку, которую вам передал владелец приложения. В этом браузере вход сохранится на 90 дней.'}</p>
  </section></main>;
}
