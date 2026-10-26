import 'server-only';
import { watchHandler } from '@/lib/watch-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = watchHandler();
