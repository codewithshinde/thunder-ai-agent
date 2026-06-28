interface MarkdownMessageProps {
  content: string;
  streaming?: boolean;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string; path?: string; streaming?: boolean };

type ListKind = 'ul' | 'ol';

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
  const nodes: Array<string | JSX.Element> = [];
  const pattern = /(`[^`]+`|\[([^\]]+)\]\(([^)]+)\)|(\*\*|__)(.+?)\4|(\*|_)([^*_]+?)\6)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const token = match[0];
    const key = `inline-${match.index}-${nodes.length}`;
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2] && match[3]) {
      const href = safeHref(match[3]);
      nodes.push(
        href ? (
          <a key={key} href={href} title={href}>
            {match[2]}
          </a>
        ) : (
          <span key={key}>{match[2]}</span>
        )
      );
    } else if (match[5]) {
      nodes.push(<strong key={key}>{renderInline(match[5])}</strong>);
    } else if (match[7]) {
      nodes.push(<em key={key}>{match[7]}</em>);
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes.length > 0 ? nodes : [text];
}

function renderTextBlock(text: string, baseKey: string): JSX.Element[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nodes: JSX.Element[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let listKind: ListKind = 'ul';
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const value = paragraph.join(' ').trim();
    if (value) nodes.push(<p key={`${baseKey}-p-${nodes.length}`}>{renderInline(value)}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    const ListTag = listKind;
    nodes.push(
      <ListTag key={`${baseKey}-${listKind}-${nodes.length}`}>
        {list.map((item, index) => <li key={index}>{renderInline(item)}</li>)}
      </ListTag>
    );
    list = [];
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    nodes.push(
      <blockquote key={`${baseKey}-quote-${nodes.length}`}>
        {renderTextBlock(quote.join('\n'), `${baseKey}-quote-${nodes.length}`)}
      </blockquote>
    );
    quote = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }

    const table = readTable(lines, lineIndex);
    if (table) {
      flushAll();
      nodes.push(renderTable(table.rows, `${baseKey}-table-${nodes.length}`));
      lineIndex = table.endIndex;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const Tag = level <= 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
      nodes.push(<Tag key={`${baseKey}-h-${nodes.length}`}>{renderInline(heading[2])}</Tag>);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      nodes.push(<hr key={`${baseKey}-hr-${nodes.length}`} />);
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      flushQuote();
      if (list.length > 0 && listKind !== 'ul') flushList();
      listKind = 'ul';
      list.push(normalizeListItem(bullet[1]));
      continue;
    }

    const numbered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      flushQuote();
      if (list.length > 0 && listKind !== 'ol') flushList();
      listKind = 'ol';
      list.push(numbered[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }

  flushAll();
  return nodes;
}

function normalizeListItem(item: string): string {
  return item.replace(/^\[( |x|X)\]\s+/, (match) => `${match.toLowerCase().includes('x') ? 'Done: ' : 'Todo: '}`);
}

function readTable(lines: string[], startIndex: number): { rows: string[][]; endIndex: number } | null {
  const header = parseTableRow(lines[startIndex]);
  const separator = parseTableRow(lines[startIndex + 1] ?? '');
  if (!header || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
    return null;
  }

  const rows = [header];
  let endIndex = startIndex + 1;
  for (let i = startIndex + 2; i < lines.length; i += 1) {
    const row = parseTableRow(lines[i]);
    if (!row) break;
    rows.push(row);
    endIndex = i;
  }

  return { rows, endIndex };
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const withoutOuter = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = withoutOuter.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function renderTable(rows: string[][], key: string): JSX.Element {
  const [head, ...body] = rows;
  return (
    <div className="markdown-table-wrap" key={key}>
      <table>
        <thead>
          <tr>
            {head.map((cell, index) => <th key={index}>{renderInline(cell)}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {head.map((_, cellIndex) => (
                <td key={cellIndex}>{renderInline(row[cellIndex] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function safeHref(value: string): string | null {
  const trimmed = value.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^#[\w-]+$/.test(trimmed)) return trimmed;
  return null;
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
