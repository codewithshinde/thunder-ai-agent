import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../../vscode/webview/messages';
import { MarkdownMessage } from './MarkdownMessage';

interface MessageListProps {
  messages: ChatMessage[];
  loading?: boolean;
}

export function MessageList({ messages, loading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  if (messages.length === 0) {
    return (
      <div className="empty-chat">
        <p className="empty-title">Thunder</p>
        <p className="empty-subtitle">Ask about your codebase. Plan, review, or apply changes.</p>
      </div>
    );
  }

  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map((msg) => (
        <article key={msg.id} className={`message message--${msg.role}`}>
          <div className="message-content">
            {msg.role === 'assistant' ? (
              msg.content ? (
                <MarkdownMessage content={msg.content} streaming={msg.streaming} />
              ) : msg.streaming ? (
                <p className="message-working">
                  <span className="message-working__pulse" aria-hidden="true" />
                  Thinking…
                </p>
              ) : null
            ) : (
              msg.content
            )}
            {msg.streaming && msg.content && !msg.content.includes('```') && (
              <span className="streaming-cursor" aria-hidden="true">▋</span>
            )}
          </div>
        </article>
      ))}
      <div ref={bottomRef} className="message-list__anchor" />
    </div>
  );
}
