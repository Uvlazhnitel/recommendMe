'use client';

import { RateWorkbench } from './rate-workbench';
import { useWorkbench } from './use-workbench';

export default function Workbench({ mode, initialMovieId, initialMovieError, home = false }: { mode: 'rate'; home?: boolean; initialMovieId?: number; initialMovieError?: string }) {
  const model = useWorkbench(mode, initialMovieId);
  return <RateWorkbench home={home} model={model} initialMovieId={initialMovieId} initialMovieError={initialMovieError} />;
}
