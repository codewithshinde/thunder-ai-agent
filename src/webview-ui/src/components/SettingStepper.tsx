interface SettingStepperProps {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function SettingStepper({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
}: SettingStepperProps) {
  const clamp = (next: number) => Math.max(min, Math.min(max, next));

  return (
    <div className={`setting-stepper ${disabled ? 'setting-stepper--disabled' : ''}`}>
      <div className="setting-stepper__text">
        <span className="setting-row__label">{label}</span>
        {description && <span className="setting-row__desc">{description}</span>}
      </div>
      <div className="setting-stepper__control">
        <button
          type="button"
          className="setting-stepper__btn"
          aria-label={`Decrease ${label}`}
          disabled={disabled || value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          −
        </button>
        <span className="setting-stepper__value" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className="setting-stepper__btn"
          aria-label={`Increase ${label}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}
