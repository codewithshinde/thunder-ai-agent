interface ErrorBannerProps {
  error: string | null;
  onRetry: () => void;
  onSettings: () => void;
  onDismiss: () => void;
}

export function ErrorBanner({ error, onRetry, onSettings, onDismiss }: ErrorBannerProps) {
  if (!error) {
    return null;
  }

  return (
    <div className="error-banner" role="alert">
      <span className="error-banner__text">{error}</span>
      <div className="error-banner__actions">
        <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onSettings}>
          Settings
        </button>
        <button type="button" className="error-banner__dismiss" onClick={onDismiss} aria-label="Dismiss error">
          ×
        </button>
      </div>
    </div>
  );
}
