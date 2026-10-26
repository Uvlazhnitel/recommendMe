'use client';

import { useEffect, useRef, useState } from 'react';
import { CinemaSpotlight, type SpotlightState } from '../../components/cinema-spotlight';
import { Button } from '../../components/ui';
import { demoMovies } from './fixtures';

export function DemoRecommendations({ controls = false }: { controls?: boolean }) {
  const [state, setState] = useState<SpotlightState>('ready');
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function show(next: SpotlightState) { if (timer.current) clearTimeout(timer.current); setNotice(''); setState(next); }
  function more() {
    show('loading');
    timer.current = setTimeout(() => { setState('ready'); setNotice('Демонстрация завершена. Новая подборка не создавалась; сеть и SQLite не использовались.'); }, 1800);
  }
  return <>
    <CinemaSpotlight movies={demoMovies} state={state} demonstration onMore={more} notice={notice}
      onWatch={movie => setNotice(`Демонстрация: «${movie.title}» — просмотр. Реальные данные не изменены.`)}
      onReject={movie => setNotice(`Демонстрация: «${movie.title}» — неинтересно. Реальные данные не изменены.`)} />
    {controls ? <details className="preview-controls"><summary>Демонстрационные состояния</summary><p>Этот экран доступен только в development. Все действия локальны.</p>
      <div className="preview-state-buttons">{(['ready', 'loading', 'empty', 'error'] as const).map((value, i) => <Button key={value} tone="quiet" onClick={() => show(value)}>{['Подборка', 'Загрузка', 'Нет результатов', 'Ошибка'][i]}</Button>)}</div>
    </details> : null}
  </>;
}
