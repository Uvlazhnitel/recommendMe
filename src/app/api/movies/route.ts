import 'server-only';
import { movieHandlers } from '@/lib/movie-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = movieHandlers().add;
