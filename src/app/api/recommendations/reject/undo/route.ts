import 'server-only';
import { rejectionHandler } from '@/lib/recommendation-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = rejectionHandler(true);
