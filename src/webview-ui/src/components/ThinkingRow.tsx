interface ThinkingRowProps {
  content: string;
  streaming?: boolean;
}

export function ThinkingRow({ content, streaming = false }: ThinkingRowProps) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  return (
    <details className="thinking-block" open={streaming}>
      <summary>{streaming ? 'Reasoning...' : 'Reasoning'}</summary>
      <p>{trimmed.slice(0, 1200)}{trimmed.length > 1200 ? '...' : ''}</p>
    </details>
  );
}
