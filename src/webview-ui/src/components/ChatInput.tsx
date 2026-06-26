import { useState, useCallback, type KeyboardEvent } from 'react';
import type { ThunderMode } from '../../../core/ThunderSession';
import type { TokenUsageView } from '../../../vscode/webview/messages';
import { IconButton } from './IconButton';
import { IconChevronDown, IconCopy, IconRetry, IconSend, IconStop } from './Icons';

interface ChatInputProps {
  loading: boolean;
  mode: ThunderMode;
  tokenUsage: TokenUsageView;
  canRetry: boolean;
  onSend: (content: string) => void;
  onStop?: () => void;
  onModeChange: (mode: ThunderMode) => void;
  onRetry?: () => void;
  onCopyResponse?: () => void;
}

const MODES: { id: ThunderMode; label: string; description: string }[] = [
  { id: 'plan', label: 'Plan', description: 'Analyze and propose steps' },
  { id: 'act', label: 'Act', description: 'Apply code changes' },
  { id: 'review', label: 'Review', description: 'Inspect code and risks' },
];

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ChatInput({
  loading,
  mode,
  tokenUsage,
  canRetry,
  onSend,
  onStop,
  onModeChange,
  onRetry,
  onCopyResponse,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0];

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    onSend(trimmed);
    setValue('');
  }, [value, loading, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const tokenHint = `${formatTokens(tokenUsage.lastPromptTokens)} in · ${formatTokens(tokenUsage.lastResponseTokens)} out`;

  return (
    <div className="composer">
      <div className="composer__box">
        <textarea
          className="composer__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything…"
          disabled={loading}
          rows={3}
          aria-label="Chat message input"
        />
        <div className="composer__footer">
          <div className="composer__left">
            <div className="composer__mode-select-wrap">
              <select
                className="composer__mode-select"
                value={mode}
                onChange={(e) => onModeChange(e.target.value as ThunderMode)}
                aria-label="Agent mode"
                title={activeMode.description}
              >
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <IconChevronDown className="composer__mode-chevron" width={12} height={12} aria-hidden />
            </div>
            <span className="composer__tokens" title="Last turn token usage">
              {tokenHint}
            </span>
          </div>
          <div className="composer__actions">
            {onRetry && (
              <IconButton label="Retry last message" variant="ghost" onClick={onRetry} disabled={loading || !canRetry}>
                <IconRetry />
              </IconButton>
            )}
            {onCopyResponse && (
              <IconButton label="Copy last response" variant="ghost" onClick={onCopyResponse} disabled={loading}>
                <IconCopy />
              </IconButton>
            )}
            {loading ? (
              <IconButton label="Stop generation" variant="accent" onClick={onStop}>
                <IconStop />
              </IconButton>
            ) : (
              <IconButton
                label="Send message"
                variant="accent"
                onClick={handleSend}
                disabled={!value.trim()}
              >
                <IconSend />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
