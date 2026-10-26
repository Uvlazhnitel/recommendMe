import 'server-only';
import { recommendationHandlers } from '@/lib/recommendations-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;
export const POST = recommendationHandlers().generate;
