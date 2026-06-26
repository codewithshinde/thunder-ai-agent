import type { ReactNode } from 'react';

interface SettingNoteProps {
  title?: string;
  children: ReactNode;
  variant?: 'info' | 'warn';
}

export function SettingNote({ title, children, variant = 'info' }: SettingNoteProps) {
  return (
    <div className={`settings-note settings-note--${variant}`}>
      {title && <p className="settings-note-title">{title}</p>}
      <div className="settings-note-body">{children}</div>
    </div>
  );
}
