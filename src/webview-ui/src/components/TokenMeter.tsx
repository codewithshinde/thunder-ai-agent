import { useEffect, useRef, useState } from 'react';
import type { TokenUsageView } from '../../../vscode/webview/messages';
import { IconTokens } from './Icons';

interface TokenMeterProps {
  usage: TokenUsageView;
  compact?: boolean;
  placement?: 'above' | 'below';
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function TokenMeter({ usage, compact = false, placement = 'below' }: TokenMeterProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const sessionTotal = usage.sessionTotal ?? inputTotal + outputTotal;
  const inputTotal = usage.inputTokensTotal ?? 0;
  const outputTotal = usage.outputTokensTotal ?? 0;
  const currentTurnTotal = usage.currentTurnTotal ?? 0;
  const currentTurnInput = usage.currentTurnInputTokens ?? 0;
  const currentTurnOutput = usage.currentTurnOutputTokens ?? 0;
  const aiCallCount = usage.aiCallCount ?? 0;
  const currentTurnAiCallCount = usage.currentTurnAiCallCount ?? 0;
  const lastCallTotal = usage.lastCallTotalTokens ?? 0;
  const lastCallInput = usage.lastCallInputTokens ?? 0;
  const lastCallOutput = usage.lastCallOutputTokens ?? 0;
  const requestTokens = lastCallInput > 0 ? lastCallInput : usage.lastPromptTokens;
  const requestPct = usage.contextWindow > 0
    ? Math.round((requestTokens / usage.contextWindow) * 100)
    : 0;
  const pct = usage.contextWindow > 0
    ? Math.round((usage.lastPromptTokens / usage.contextWindow) * 100)
    : 0;
  const overBudget = requestPct > 100;

  const tooltip = [
    `Session total: ${sessionTotal.toLocaleString()} tokens (input + output)`,
    `Input: ${inputTotal.toLocaleString()} · Output: ${outputTotal.toLocaleString()}`,
    `Context window: ${usage.contextWindow.toLocaleString()} tokens`,
    `AI calls: ${aiCallCount.toLocaleString()} total · ${currentTurnAiCallCount.toLocaleString()} this turn`,
    `Latest AI call: ${requestTokens.toLocaleString()} input (${requestPct}% of window)`,
    `${usage.turnCount} turns`,
  ].join('\n');

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (compact) {
    const totalBreakdown = usage.breakdown.reduce((sum, item) => sum + item.tokens, 0);
    return (
      <div className={`token-popover token-popover--${placement}`} ref={popoverRef}>
        <button
          type="button"
          className={`token-chip${open ? ' token-chip--active' : ''}`}
          title={tooltip}
          aria-label="Session token usage"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <IconTokens width={13} height={13} />
          <span>{formatCompact(sessionTotal)}</span>
          <span className="token-chip__sep">·</span>
          <span>{formatCompact(usage.contextWindow)} window</span>
        </button>
        {open && (
          <div className="token-popover__panel" role="dialog" aria-label="Token usage details">
            <div className="token-popover__header">
              <span>Session AI Tokens</span>
              <strong>{usage.estimated ? 'Estimated' : 'Provider reported'}</strong>
            </div>
            <div className="token-popover__summary">
              <span>{formatCompact(sessionTotal)} lifetime input + output · {aiCallCount.toLocaleString()} calls</span>
            </div>
            <dl className="token-popover__stats token-popover__stats--primary">
              <div>
                <dt>Total input</dt>
                <dd>{inputTotal.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Total output</dt>
                <dd>{outputTotal.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Turn total</dt>
                <dd>{currentTurnTotal.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Turn AI calls</dt>
                <dd>{currentTurnAiCallCount.toLocaleString()}</dd>
              </div>
            </dl>
            <div className="token-popover__section-title">
              <span>Latest AI Call</span>
              <strong>{overBudget ? `${requestPct}% Over budget` : `${requestPct}% Used`}</strong>
            </div>
            <div className="token-popover__summary">
              <span>{formatCompact(requestTokens)} input / {formatCompact(usage.contextWindow)} window</span>
            </div>
            <div className="token-popover__bar" aria-hidden="true">
              <div
                className={`token-popover__fill${overBudget ? ' token-popover__fill--over' : ''}`}
                style={{ width: `${Math.min(100, requestPct)}%` }}
              />
            </div>
            <div className="token-popover__summary token-popover__summary--secondary">
              <span>Session total: {formatCompact(sessionTotal)} · Retrieved pack: {formatCompact(usage.lastContextTokens)}</span>
            </div>
            {usage.breakdown.length > 0 && (
              <div className="token-popover__segments" aria-hidden="true">
                {usage.breakdown.map((item) => (
                  <span
                    key={item.label}
                    style={{
                      width: `${Math.max(2, (item.tokens / Math.max(totalBreakdown, 1)) * 100)}%`,
                      background: item.color,
                    }}
                  />
                ))}
              </div>
            )}
            {usage.breakdown.length > 0 && (
              <dl className="token-popover__breakdown">
                {usage.breakdown.map((item) => (
                  <div key={item.label}>
                    <dt>
                      <span style={{ background: item.color }} aria-hidden="true" />
                      {item.label}
                    </dt>
                    <dd>{formatCompact(item.tokens)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <dl className="token-popover__stats">
              <div>
                <dt>Last AI call</dt>
                <dd>{lastCallTotal.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Call input</dt>
                <dd>{lastCallInput.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Call output</dt>
                <dd>{lastCallOutput.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Turn input total</dt>
                <dd>{currentTurnInput.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Turn output total</dt>
                <dd>{currentTurnOutput.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Last request input</dt>
                <dd>{usage.lastPromptTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Retrieved context</dt>
                <dd>{usage.lastContextTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Last output</dt>
                <dd>{usage.lastResponseTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd>{usage.turnCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Window used</dt>
                <dd>{pct}%</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="token-meter" title={tooltip}>
      <div className="token-meter__row">
        <span className="token-meter__label">Session tokens</span>
        <span className="token-meter__value">{formatCompact(sessionTotal)}</span>
      </div>
      <div className="token-meter__bar" aria-hidden="true">
        <div className="token-meter__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
