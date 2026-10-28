import 'server-only';
import { reviewHandler } from '@/lib/review-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const PATCH = reviewHandler();
