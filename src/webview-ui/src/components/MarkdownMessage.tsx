interface MarkdownMessageProps {
  content: string;
  streaming?: boolean;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string; path?: string; streaming?: boolean };

function parseFenceHeader(headerLine: string): { language: string; path?: string } {
  const trimmed = headerLine.trim();
  const codeEdit = /^([\w+-]*)\|CODE_EDIT_BLOCK\|(.+)$/.exec(trimmed);
  if (codeEdit) {
    return { language: codeEdit[1] || 'code', path: codeEdit[2].trim() };
  }
  return { language: trimmed || 'code' };
}

function splitSegments(content: string, streaming = false): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  while (i < content.length) {
    const fenceStart = content.indexOf('```', i);
    if (fenceStart === -1) {
      const tail = content.slice(i);
      if (tail.trim()) segments.push({ type: 'text', value: tail });
      break;
    }

    if (fenceStart > i) {
      segments.push({ type: 'text', value: content.slice(i, fenceStart) });
    }

    const headerEnd = content.indexOf('\n', fenceStart + 3);
    if (headerEnd === -1) {
      if (streaming) {
        const { language, path } = parseFenceHeader(content.slice(fenceStart + 3));
        segments.push({ type: 'code', value: '', language, path, streaming: true });
      }
      break;
    }

    const { language, path } = parseFenceHeader(content.slice(fenceStart + 3, headerEnd));
    const codeStart = headerEnd + 1;
    const fenceEnd = content.indexOf('```', codeStart);

    if (fenceEnd === -1) {
      segments.push({
        type: 'code',
        value: content.slice(codeStart),
        language,
        path,
        streaming: streaming,
      });
      break;
    }

    segments.push({
      type: 'code',
      value: content.slice(codeStart, fenceEnd).replace(/\n$/, ''),
      language,
      path,
    });
    i = fenceEnd + 3;
  }

  return segments;
}

function renderInline(text: string): Array<string | JSX.Element> {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function renderTextBlock(text: string, baseKey: string): JSX.Element[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nodes: JSX.Element[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const value = paragraph.join(' ').trim();
    if (value) nodes.push(<p key={`${baseKey}-p-${nodes.length}`}>{renderInline(value)}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    nodes.push(
      <ul key={`${baseKey}-ul-${nodes.length}`}>
        {list.map((item, index) => <li key={index}>{renderInline(item)}</li>)}
      </ul>
    );
    list = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      nodes.push(<h3 key={`${baseKey}-h-${nodes.length}`}>{renderInline(heading[2])}</h3>);
      return;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      return;
    }

    const numbered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      list.push(numbered[1]);
      return;
    }

    flushList();
    paragraph.push(trimmed);
  });

  flushParagraph();
  flushList();
  return nodes;
}

function extractThinking(content: string): { thinking: string | null; visible: string } {
  const match = /<think>([\s\S]*?)<\/think>/i.exec(content);
  if (!match) return { thinking: null, visible: content };
  return {
    thinking: match[1].trim(),
    visible: content.replace(match[0], '').trim(),
  };
}

function CodeBlock({
  language,
  path,
  value,
  streaming,
}: {
  language: string;
  path?: string;
  value: string;
  streaming?: boolean;
}) {
  const label = path ? path : language;
  return (
    <div className={`code-block${streaming ? ' code-block--streaming' : ''}`}>
      <div className="code-block__header">
        <span className="code-block__label">{label}</span>
        {streaming && <span className="code-block__status">Generating…</span>}
      </div>
      <pre><code>{value || ' '}</code></pre>
    </div>
  );
}

export function MarkdownMessage({ content, streaming = false }: MarkdownMessageProps) {
  const { thinking, visible } = extractThinking(content);
  const segments = splitSegments(visible, streaming);

  return (
    <div className="markdown-message">
      {thinking && (
        <details className="thinking-block">
          <summary>Reasoning</summary>
          <p>{thinking.slice(0, 500)}{thinking.length > 500 ? '…' : ''}</p>
        </details>
      )}
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <CodeBlock
            key={index}
            language={segment.language}
            path={segment.path}
            value={segment.value}
            streaming={segment.streaming}
          />
        ) : (
          <div key={index}>{renderTextBlock(segment.value, `seg-${index}`)}</div>
        )
      )}
    </div>
  );
}
