// Only TMDB's image path is accepted; callers cannot turn this into an arbitrary URL.
export function tmdbImage(path: string | null | undefined, size: 'w342' | 'w500' | 'w1280' = 'w500') {
  return typeof path === 'string' && /^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path)
    ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

export const previewEnabled = (environment: string | undefined) => environment === 'development';
