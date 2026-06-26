import type { ChatMessage } from '../../../vscode/webview/messages';

interface MessageListProps {
  messages: ChatMessage[];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="empty-chat">
        <p className="empty-title">Welcome to Thunder</p>
        <p className="empty-subtitle">Ask a question about your codebase to get started.</p>
      </div>
    );
  }

  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map((msg) => (
        <div key={msg.id} className={`message message--${msg.role}`}>
          <div className="message-header">
            <span className="message-role">{msg.role === 'user' ? 'You' : 'Thunder'}</span>
            <span className="message-time">{formatTime(msg.timestamp)}</span>
          </div>
          <div className="message-content">
            {msg.content}
            {msg.streaming && <span className="streaming-cursor" aria-hidden="true">▋</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
