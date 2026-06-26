import { useState, useCallback, type KeyboardEvent } from 'react';

interface ChatInputProps {
  loading: boolean;
  onSend: (content: string) => void;
  onStop?: () => void;
}

export function ChatInput({ loading, onSend, onStop }: ChatInputProps) {
  const [value, setValue] = useState('');

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || loading) {
      return;
    }
    onSend(trimmed);
    setValue('');
  }, [value, loading, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-input">
      <textarea
        className="chat-input__textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask Thunder about your code..."
        disabled={loading}
        rows={3}
        aria-label="Chat message input"
      />
      <div className="chat-input__actions">
        {loading ? (
          <button type="button" className="btn btn--secondary" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSend}
            disabled={!value.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
