'use client';

import { useId, type CSSProperties } from 'react';
import { ratingDraft } from '../rating-draft';

const commitKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);

export function RatingControl({ value, onChange, watched }: { value: string; onChange: (value: string) => void; watched: boolean }) {
  const id = useId(), draft = ratingDraft(value);
  const selected = draft.value !== null;
  return <div className={`rating-control ${selected ? 'has-rating' : 'no-rating'}`}>
    <div className="rating-control-heading"><label htmlFor={`${id}-range`}>{watched ? 'Ваша оценка' : 'Оценка просмотра'}<span>{watched ? 'Измените своё впечатление' : 'Можно оставить без оценки'}</span></label>
      <output className="rating-number" htmlFor={`${id}-range ${id}-exact`}>{selected ? <><strong>{draft.value}</strong><span>/100</span></> : <span className="rating-unset">{draft.invalid ? 'Проверьте число' : 'Без оценки'}</span>}</output>
    </div>
    <input id={`${id}-range`} className="rating-range" type="range" min={0} max={100} step={1} value={draft.value ?? 50}
      aria-valuetext={selected ? `${draft.value} из 100` : 'Без оценки. Измените шкалу или введите число.'} aria-describedby={`${id}-help`}
      style={{ '--rating-fill': `${draft.value ?? 0}%` } as CSSProperties}
      onChange={event => onChange(event.target.value)} onPointerUp={event => { if (event.button === 0 && !event.currentTarget.matches(':disabled')) onChange(event.currentTarget.value); }}
      onKeyUp={event => { if (commitKeys.has(event.key)) onChange(event.currentTarget.value); }} />
    <div className="rating-endpoints" aria-hidden="true"><span>0</span><span>100</span></div>
    <div className="rating-exact"><label htmlFor={`${id}-exact`}>Точное число</label><div className="input-with-suffix"><input id={`${id}-exact`} name={watched ? 'edit-rating' : 'watch-rating'} type="number" inputMode="numeric" min={0} max={100} step={1}
      placeholder="—" value={value} onChange={event => onChange(event.target.value)} aria-invalid={draft.invalid || undefined} aria-describedby={`${id}-help`} /><span>/ 100</span></div></div>
    <p id={`${id}-help`} className={draft.invalid ? 'rating-validation' : 'field-help'}>{draft.invalid ? 'Введите целое число от 0 до 100.' : selected ? 'Ноль — настоящая оценка. Изменения сохранятся только по кнопке.' : 'Выберите число на шкале или введите его ниже. Можно оставить поле пустым.'}</p>
  </div>;
}
