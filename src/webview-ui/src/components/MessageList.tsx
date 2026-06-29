import { useEffect, useRef } from 'react';
import type { AgentActivityEntry, AgentLiveStatusView, ApprovalRequestView, ChatMessage } from '../../../vscode/webview/messages';
import { AGENT_NAME } from '../../../shared/brand';
import { MarkdownMessage } from './MarkdownMessage';
import { AgentActivityPanel } from './AgentActivityPanel';
import { useStreamReveal } from '../hooks/useStreamReveal';

interface MessageListProps {
  messages: ChatMessage[];
  loading?: boolean;
  agentActivity?: AgentActivityEntry[];
  agentLiveStatus?: AgentLiveStatusView | null;
  approvals?: ApprovalRequestView[];
}

function AssistantMessage({ content, streaming }: { content: string; streaming?: boolean }) {
  const revealed = useStreamReveal(content, Boolean(streaming));
  return <MarkdownMessage content={revealed} streaming={streaming} />;
}

export function MessageList({ messages, loading, agentActivity = [], agentLiveStatus = null, approvals = [] }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading, agentActivity.length, agentLiveStatus?.label, agentLiveStatus?.stepCurrent, approvals.length]);

  if (messages.length === 0) {
    return (
      <div className="empty-chat">
        <p className="empty-title">{AGENT_NAME}</p>
        <p className="empty-subtitle">Ask about your codebase. Plan, review, or apply changes in Agent mode.</p>
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
                <AssistantMessage content={msg.content} streaming={msg.streaming} />
              ) : msg.streaming ? (
                <p className="message-working">
                  <span className="message-working__pulse" aria-hidden="true" />
                  Thinking…
                </p>
              ) : (
                <p className="message-working message-working--muted">No response text</p>
              )
            ) : (
              msg.content
            )}
            {msg.streaming && msg.content && !msg.content.includes('```') && (
              <span className="streaming-cursor streaming-cursor--pulse" aria-hidden="true">▋</span>
            )}
          </div>
        </article>
      ))}
      {(loading || agentActivity.length > 0 || approvals.length > 0) && (
        <article className="message message--assistant message--activity">
          <div className="message-content">
            <AgentActivityPanel
              entries={agentActivity}
              loading={Boolean(loading)}
              liveStatus={agentLiveStatus}
              waitingForApproval={!loading && approvals.length > 0}
            />
          </div>
        </article>
      )}
      <div ref={bottomRef} className="message-list__anchor" />
    </div>
  );
}
