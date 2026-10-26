import type { Metadata } from 'next';
import Workbench from '../workbench';
import { PageHeader } from '../components/ui';

export const metadata: Metadata = { title: 'Оценить фильм' };
export default function RatePage() {
  return <><PageHeader title="Оценить фильм" description="Найдите нужный фильм. Сохраните просмотр и своё впечатление." /><Workbench mode="rate" /></>;
}
