'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';

const destinations = [
  { href: '/', label: 'Рекомендации', icon: 'home' },
  { href: '/rate', label: 'Оценить фильм', icon: 'star' },
  { href: '/watchlist', label: 'Посмотреть позже', icon: 'bookmark' },
  { href: '/library', label: 'Библиотека', icon: 'library' },
] as const;

export function Navigation() {
  const pathname = usePathname();
  return <nav className="navigation" aria-label="Основная навигация">
    {destinations.map(item => {
      const active = item.href === '/' ? pathname === '/' || pathname.startsWith('/preview/') : pathname === item.href;
      return <Link key={item.href} href={item.href} className={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined}>
        <Icon name={item.icon} /><span>{item.label}</span>
      </Link>;
    })}
  </nav>;
}
