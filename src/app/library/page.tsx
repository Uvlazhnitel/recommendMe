import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LibraryWorkbench } from '../library-workbench';
import { LoadingState } from '../components/ui';

export const metadata: Metadata = { title: 'Моя библиотека' };
export default function LibraryPage() {
  return <Suspense fallback={<LoadingState>Загрузка библиотеки…</LoadingState>}><LibraryWorkbench /></Suspense>;
}
