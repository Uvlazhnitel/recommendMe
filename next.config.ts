import type { NextConfig } from 'next';

const config: NextConfig = {
  devIndicators: false,
  images: {
    remotePatterns: ['w342', 'w500', 'w1280'].map(size => ({
      protocol: 'https' as const, hostname: 'image.tmdb.org', port: '', pathname: `/t/p/${size}/*`, search: '',
    })),
  },
};
export default config;
