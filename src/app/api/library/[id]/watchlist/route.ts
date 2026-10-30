import 'server-only';
import {watchlistHandler} from '@/lib/watchlist-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const PATCH=watchlistHandler();
