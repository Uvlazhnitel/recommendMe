import 'server-only';
import { accessStatus, exchangeAccess } from '@/lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = accessStatus;
export const POST = exchangeAccess;
