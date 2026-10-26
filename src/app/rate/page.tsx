import type { Metadata } from 'next';
import Workbench from '../workbench';
import { parseRateSelection } from '../rating-draft';
import { PageHeader } from '../components/ui';

export const metadata: Metadata = { title: 'Оценить фильм' };
export default async function RatePage({ searchParams }: { searchParams: Promise<{ movie_id?: string | string[] }> }) {
  const value = (await searchParams).movie_id;
  const { movieId: initialMovieId, error: initialMovieError } = parseRateSelection(value);
  return <><PageHeader title="Оценить фильм" description="Найдите нужный фильм. Сохраните просмотр и своё впечатление." /><Workbench key={JSON.stringify(value) ?? 'search'} mode="rate" initialMovieId={initialMovieId} initialMovieError={initialMovieError} /></>;
}
