import type { Metadata } from 'next';
import { WatchlistWorkbench } from '../watchlist-workbench';

export const metadata: Metadata = { title: 'Посмотреть позже' };
export default function WatchlistPage() { return <WatchlistWorkbench />; }
