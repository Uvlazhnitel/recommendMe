'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useProfile } from './profile-provider';
import { activeTab, tabUrl } from '../navigation-state';
import { Icon } from './icons';

const destinations = [
  { href: '/', label: 'Рекомендации', icon: 'home' },
  { href: '/rate', label: 'Оценить фильм', icon: 'star' },
  { href: '/watchlist', label: 'Посмотреть позже', icon: 'bookmark' },
  { href: '/library', label: 'Библиотека', icon: 'library' },
] as const;

export function Navigation() {
  useProfile();
  const pathname = usePathname(), params = useSearchParams();
  return <nav className="navigation" aria-label="Основная навигация">
    {destinations.map(item => {
      const active = activeTab(pathname, params) === item.href;
      return <Link key={item.href} href={tabUrl(item.href)} scroll={false} className={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined}>
        <Icon name={item.icon} /><span>{item.label}</span>
      </Link>;
    })}
  </nav>;
}
