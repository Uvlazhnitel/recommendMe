import 'server-only';
import { checkDatabase } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  try {
    checkDatabase({ readonly: true });
    return Response.json({ status: 'ok', database: 'ok' }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    console.error('SQLite health check failed. Check the database path and permissions.');
    return Response.json({ status: 'error', database: 'unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
