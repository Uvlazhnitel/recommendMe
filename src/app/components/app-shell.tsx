import { ProfileProvider, ProfileGate, ProfileControl } from './profile-provider';
import Link from 'next/link';
import { Navigation } from './navigation';
import { Suspense } from 'react';
import { NavigationProvider } from './navigation-provider';
import { AccessGate } from './access-gate';

export function AppShell({ children }: { children: React.ReactNode }) {
  return <AccessGate><ProfileProvider><NavigationProvider>
    <a className="skip-link" href="#main">К содержимому</a>
    <header className="site-header">
      <Link href="/" className="wordmark" aria-label="recommendMe — рекомендации">recommend<span>Me</span></Link>
      <Suspense><Navigation /></Suspense><ProfileControl />
    </header>
    <main id="main" className="app-main"><ProfileGate>{children}</ProfileGate></main>
  </NavigationProvider></ProfileProvider></AccessGate>;
}
