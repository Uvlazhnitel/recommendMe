import type { Metadata } from 'next';
import Workbench from '../workbench';
import { PageHeader } from '../components/ui';

export const metadata: Metadata = { title: 'Оценить фильм' };
export default async function RatePage({ searchParams }: { searchParams: Promise<{ movie_id?: string | string[] }> }) {
  const value = (await searchParams).movie_id;
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  const initialMovieId = Number.isSafeInteger(id) ? id : undefined;
  return <><PageHeader title="Оценить фильм" description="Найдите нужный фильм. Сохраните просмотр и своё впечатление." /><Workbench key={initialMovieId ?? 'search'} mode="rate" initialMovieId={initialMovieId} /></>;
}
