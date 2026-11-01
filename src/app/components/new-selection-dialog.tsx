'use client';

import type { RefObject } from 'react';
import { MOODS, type RecommendationPreferences } from '@/lib/recommendation-preferences';
import { Icon } from './icons';
import { Button } from './ui';
import { trapDialogFocus } from './home-gallery';

export function NewSelectionDialog({ dialog, preferences, onChange, onGenerate, busy = false }: {
  busy?: boolean; dialog: RefObject<HTMLDialogElement | null>;
  preferences: RecommendationPreferences;
  onChange: (patch: Partial<RecommendationPreferences>) => void;
  onGenerate: () => void;
}) {
  return <dialog ref={dialog} className="new-selection-dialog" aria-labelledby="selection-heading" aria-describedby="selection-description" onKeyDown={trapDialogFocus} onClose={() => {
    const button = document.getElementById('configure-selection') as HTMLButtonElement | null;
    if (button && !button.disabled) button.focus(); else document.getElementById('home-results-title')?.focus();
  }}>
    <div className="selection-dialog-heading"><div>
      <h2 id="selection-heading" tabIndex={-1} autoFocus>Настроить подбор</h2>
      <p id="selection-description">Какого кино хочется сегодня?</p>
    </div><Button tone="quiet" type="button" className="dialog-close" aria-label="Закрыть настройки" onClick={() => dialog.current?.close()}><Icon name="close" /></Button></div>
    <div className="selection-dialog-content">
      <fieldset className="selection-moods" disabled={busy}><legend className="sr-only">Настроение</legend>
        {MOODS.map(mood => <label key={mood.id} className={`selection-mood${preferences.mood === mood.id ? ' is-selected' : ''}`}>
          <input type="radio" name="mood" value={mood.id} checked={preferences.mood === mood.id} onChange={() => onChange({ mood: mood.id })} />
          <span>{mood.title}</span>
        </label>)}
      </fieldset>
      <fieldset className="selection-runtime" disabled={busy}><legend>Длительность</legend><div>
        {([{ value: null, title: 'Любая' }, { value: 120, title: 'До 2 часов' }, { value: 100, title: 'До 100 минут' }] as const).map(option => <label key={option.title} className={preferences.max_runtime === option.value ? 'is-selected' : ''}>
          <input type="radio" name="runtime" checked={preferences.max_runtime === option.value} onChange={() => onChange({ max_runtime: option.value })} /><span>{option.title}</span>
        </label>)}
      </div></fieldset>
      <fieldset className="selection-avoid" disabled={busy}><legend>Сегодня не хочется</legend><div>
        {([['avoid_horror', 'Ужасов'], ['avoid_heavy', 'Тяжёлых тем'], ['avoid_slow', 'Слишком медленного кино']] as const).map(([key, title]) => <label key={key}><span>{title}</span><input type="checkbox" checked={preferences[key]} onChange={e => onChange({ [key]: e.target.checked })} /></label>)}
      </div></fieldset>
      <p className="selection-note">Пожелания относятся только к новой подборке</p>
    </div>
    <div className="selection-dialog-actions">
      <Button type="button" disabled={busy} onClick={onGenerate}>Подобрать фильмы</Button>
      <p>Подбор использует платный API</p>
    </div>
  </dialog>;
}
