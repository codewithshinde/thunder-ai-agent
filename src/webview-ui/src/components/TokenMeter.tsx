import type { TokenUsageView } from '../../../vscode/webview/messages';
import { IconTokens } from './Icons';

interface TokenMeterProps {
  usage: TokenUsageView;
  compact?: boolean;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function TokenMeter({ usage, compact = false }: TokenMeterProps) {
  const pct = usage.contextWindow > 0
    ? Math.min(100, Math.round((usage.lastPromptTokens / usage.contextWindow) * 100))
    : 0;

  const tooltip = [
    `Session: ${usage.sessionTotal.toLocaleString()} tokens`,
    `Last prompt: ${usage.lastPromptTokens.toLocaleString()}`,
    `Context: ${usage.lastContextTokens.toLocaleString()} · Output: ${usage.lastResponseTokens.toLocaleString()}`,
    `${usage.turnCount} turns · ${pct}% of context window`,
  ].join('\n');

  if (compact) {
    return (
      <span className="token-chip" title={tooltip}>
        <IconTokens width={13} height={13} />
        <span>{formatCompact(usage.sessionTotal)}</span>
      </span>
    );
  }

  return (
    <div className="token-meter" title={tooltip}>
      <div className="token-meter__row">
        <span className="token-meter__label">Tokens</span>
        <span className="token-meter__value">{formatCompact(usage.sessionTotal)}</span>
      </div>
      <div className="token-meter__bar" aria-hidden="true">
        <div className="token-meter__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
