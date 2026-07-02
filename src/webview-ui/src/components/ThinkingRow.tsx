import { useMemo } from 'react';
import { useStreamReveal } from '../hooks/useStreamReveal';

interface ThinkingRowProps {
  content: string;
  streaming?: boolean;
  maxChars?: number;
  visible?: boolean;
}

export function ThinkingRow({ content, streaming = false, maxChars = 8000, visible = true }: ThinkingRowProps) {
  const trimmed = content.trim();
  const revealed = useStreamReveal(trimmed, streaming);
  const display = useMemo(() => {
    if (maxChars <= 0 || revealed.length <= maxChars) return revealed;
    return `${revealed.slice(0, maxChars)}\n\n[Reasoning preview truncated: ${revealed.length - maxChars} chars hidden]`;
  }, [maxChars, revealed]);
  if (!visible || !trimmed) return null;

  const firstLine = trimmed.split(/\r?\n/).find(Boolean)?.slice(0, 96) ?? 'Reasoning';
  const summary = streaming
    ? `Reasoning... ${trimmed.length.toLocaleString()} chars`
    : `Reasoning (${trimmed.length.toLocaleString()} chars) - ${firstLine}`;

  return (
    <details className="thinking-block" open={streaming}>
      <summary>{summary}</summary>
      <pre>{display}</pre>
    </details>
  );
}
