import type { ReactNode } from 'react';

interface SettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SettingsCard({ title, description, children }: SettingsCardProps) {
  return (
    <section className="settings-card">
      <header className="settings-card__header">
        <h3 className="settings-card__title">{title}</h3>
        {description && <p className="settings-card__desc">{description}</p>}
      </header>
      <div className="settings-card__body">{children}</div>
    </section>
  );
}
