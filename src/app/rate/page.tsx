import type { Metadata } from 'next';
import Workbench from '../workbench';
import { parseRateSelection } from '../rating-draft';
import { PageHeader } from '../components/ui';

export const metadata: Metadata = { title: 'Оценить фильм' };
export default async function RatePage({ searchParams }: { searchParams: Promise<{ movie_id?: string | string[]; from?: string | string[] }> }) {
  const params = await searchParams, value = params.movie_id;
  const home = params.from === 'home';
  const { movieId: initialMovieId, error: initialMovieError } = parseRateSelection(value);
  return <><PageHeader title="Оценить фильм" description="Найдите нужный фильм. Сохраните просмотр и своё впечатление." /><Workbench mode="rate" home={home} initialMovieId={initialMovieId} initialMovieError={initialMovieError} /></>;
}
