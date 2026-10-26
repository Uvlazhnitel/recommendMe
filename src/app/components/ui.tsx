import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './icons';

export function Button({ tone = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'light' | 'quiet' }) {
  return <button className={`button button-${tone} ${className}`} {...props} />;
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return <div className="page-heading"><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <section className="empty-state"><Icon name="film" /><h2>{title}</h2><div>{children}</div></section>;
}

export function LoadingState({ children = 'Загрузка…' }: { children?: ReactNode }) {
  return <div className="loading-state" role="status"><span className="loading-dot" />{children}</div>;
}

export function ErrorState({ children }: { children: ReactNode }) {
  return <p className="error-state" role="alert">{children}</p>;
}
