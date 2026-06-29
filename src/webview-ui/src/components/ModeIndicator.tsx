import type { ThunderMode } from '../../../core/ThunderSession';

interface ModeIndicatorProps {
  mode: ThunderMode;
  onChange: (mode: ThunderMode) => void;
}

const MODES: { id: ThunderMode; label: string; description: string }[] = [
  { id: 'ask', label: 'Ask', description: 'Explore and answer — read-only' },
  { id: 'plan', label: 'Plan', description: 'Analyze and propose — no writes' },
  { id: 'agent', label: 'Agent', description: 'Execute with approval' },
  { id: 'review', label: 'Review', description: 'Inspect diffs and tests' },
];

export function ModeIndicator({ mode, onChange }: ModeIndicatorProps) {
  return (
    <div className="mode-indicator" role="group" aria-label="Agent mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`mode-btn ${mode === m.id ? 'mode-btn--active' : ''}`}
          onClick={() => onChange(m.id)}
          title={m.description}
          aria-pressed={mode === m.id}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
