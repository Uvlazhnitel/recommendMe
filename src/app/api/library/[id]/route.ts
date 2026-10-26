import 'server-only';
import { libraryHandlers } from '@/lib/library-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = libraryHandlers().details;
