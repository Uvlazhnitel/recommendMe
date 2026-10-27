'use client';

import { RateWorkbench } from './rate-workbench';
import { useWorkbench } from './use-workbench';

export default function Workbench({ mode, initialMovieId, initialMovieError }: { mode: 'rate'; initialMovieId?: number; initialMovieError?: string }) {
  const model = useWorkbench(mode, initialMovieId);
  return <RateWorkbench model={model} initialMovieId={initialMovieId} initialMovieError={initialMovieError} />;
}
