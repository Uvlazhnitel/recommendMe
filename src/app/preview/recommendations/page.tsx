import { notFound } from 'next/navigation';
import { previewEnabled } from '@/lib/movie-images';

export const dynamic = 'force-dynamic';
export default async function RecommendationsPreview({ searchParams }: { searchParams: Promise<{ controls?: string }> }) {
  if (!previewEnabled(process.env.NODE_ENV)) notFound();
  const controls = (await searchParams).controls === '1';
  const { DemoRecommendations } = await import('./demo');
  return <DemoRecommendations controls={controls} />;
}
