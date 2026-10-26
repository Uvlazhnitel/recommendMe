import type { Metadata } from 'next';
import Workbench from '../workbench';
import { PageHeader } from '../components/ui';

export const metadata: Metadata = { title: 'Библиотека' };
export default function LibraryPage() {
  return <><PageHeader title="Библиотека" description="Просмотренные фильмы и ваши оценки. История, которую стоит сохранить." /><Workbench mode="library" /></>;
}
