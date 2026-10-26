import Link from 'next/link';
import { Navigation } from './navigation';

export function AppShell({ children }: { children: React.ReactNode }) {
  return <>
    <a className="skip-link" href="#main">К содержимому</a>
    <header className="site-header">
      <Link href="/" className="wordmark" aria-label="recommendMe — рекомендации">recommend<span>Me</span></Link>
      <Navigation />
    </header>
    <main id="main" className="app-main">{children}</main>
  </>;
}
