'use client';

import Image, { type StaticImageData } from 'next/image';
import { useState } from 'react';
import { tmdbImage } from '@/lib/movie-images';
import { Icon } from './icons';

export function MoviePoster({ path, image, title, className = '', sizes = '160px', priority = false }: {
  path?: string | null; image?: StaticImageData; title: string; className?: string; sizes?: string; priority?: boolean;
}) {
  const source = image ?? tmdbImage(path);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const identity = typeof source === 'string' ? source : source?.src;
  return <span className={`movie-poster ${className}`}>
    {source && identity !== failedSource ? <Image src={source} alt={`Постер: ${title}`} fill sizes={sizes} preload={priority} onError={() => setFailedSource(identity ?? null)} /> :
      <span className="poster-fallback" role="img" aria-label={`Постер отсутствует: ${title}`}><Icon name="film" /><span>Нет постера</span></span>}
  </span>;
}
