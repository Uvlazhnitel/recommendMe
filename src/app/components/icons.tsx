import type { SVGProps } from 'react';

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: 'home' | 'star' | 'library' | 'check' | 'arrow' | 'arrow-up-right' | 'plus' | 'close' | 'film' }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {name === 'home' ? <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1Z" /> : null}
    {name === 'star' ? <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1Z" /> : null}
    {name === 'library' ? <><rect x="3" y="3" width="5" height="18" rx="1" /><rect x="10" y="3" width="5" height="18" rx="1" /><path d="m18 3 3 17" /></> : null}
    {name === 'check' ? <path d="m5 12 4 4L19 6" /> : null}
    {name === 'arrow' ? <path d="M5 12h14m-5-5 5 5-5 5" /> : null}
    {name === 'arrow-up-right' ? <path d="M5 19 19 5M5 5h14v14" /> : null}
    {name === 'plus' ? <path d="M12 4v16M4 12h16" /> : null}
    {name === 'close' ? <path d="m6 6 12 12M6 18 18 6" /> : null}
    {name === 'film' ? <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4" /></> : null}
  </svg>;
}
