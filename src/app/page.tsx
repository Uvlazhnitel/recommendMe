import Link from 'next/link';
import { Button, EmptyState, PageHeader } from './components/ui';

export default function Home() {
  return <>
    <PageHeader title="Что посмотреть?" />
    <Button className="desktop-more" disabled aria-describedby="recommendations-availability">Ещё рекомендации</Button>
    <EmptyState title="Здесь будет ваша подборка">
      <p id="recommendations-availability">Получение сохранённых подборок и новый подбор появятся на следующем этапе. Сейчас рекомендации доступны через CLI.</p>
      <Link className="button button-light" href="/rate">Оценить фильм</Link>
    </EmptyState>
  </>;
}
