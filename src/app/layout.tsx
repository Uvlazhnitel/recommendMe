import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppShell } from './components/app-shell';
import './globals.css';

const manrope = localFont({ src: './fonts/Manrope.ttf', variable: '--font-manrope', display: 'swap', weight: '200 800' });

export const metadata: Metadata = {
  title: { default: 'recommendMe — персональное кино', template: '%s · recommendMe' },
  description: 'Персональные рекомендации фильмов',
  applicationName: 'recommendMe',
  appleWebApp: { capable: true, title: 'recommendMe', statusBarStyle: 'black' },
  // Keep standalone support on iOS versions that require the legacy Apple tag.
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = { themeColor: '#101113', colorScheme: 'dark' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" className={manrope.variable}><body><AppShell>{children}</AppShell></body></html>;
}
