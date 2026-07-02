import { useState, useCallback, type KeyboardEvent, useRef, useEffect } from 'react';
import type { ThunderMode } from '../../../core/session/ThunderSession';
import type {
  ApprovalMode,
  AgentDepthView,
  ContextPathSuggestion,
  PinnedContextView,
  TokenUsageView,
} from '../../../vscode/webview/messages';
import { IconButton } from './IconButton';
import { IconChevronDown, IconCopy, IconMarkdown, IconRetry, IconSend, IconStop } from './Icons';
import { TokenMeter } from './TokenMeter';
import { APPROVAL_MODE_OPTIONS, deriveSafetySettings } from '../utils/approvalMode';

interface ChatInputProps {
  loading: boolean;
  mode: ThunderMode;
  approvalMode: ApprovalMode;
  activeDepth: AgentDepthView;
  tokenUsage: TokenUsageView;
  pinnedContext: PinnedContextView[];
  canRetry: boolean;
  onSend: (content: string, pinnedContext: PinnedContextView[]) => void;
  onStop?: () => void;
  onModeChange: (mode: ThunderMode) => void;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onDepthChange: (depth: AgentDepthView) => void;
  onRetry?: () => void;
  onCopyResponse?: () => void;
  onCopyChatHistory?: () => void;
  canCopyChatHistory?: boolean;
  onAddPinned: (path: string, kind: 'file' | 'folder') => void;
  onSearchPaths: (query: string, requestId: string) => void;
  pathSuggestions: ContextPathSuggestion[];
  pathSearchRequestId: string | null;
}

const MODES: { id: ThunderMode; label: string; description: string }[] = [
  { id: 'ask', label: 'Ask', description: 'Explore and answer questions (read-only)' },
  { id: 'plan', label: 'Plan', description: 'Analyze and propose steps' },
  { id: 'agent', label: 'Agent', description: 'Apply code changes' },
  { id: 'review', label: 'Review', description: 'Inspect code and risks' },
];

const DEPTH_OPTIONS: Array<{ id: AgentDepthView; label: string; title: string }> = [
  { id: 'auto', label: 'Auto', title: 'Choose depth from the request' },
  { id: 'quick', label: 'Quick', title: 'Use a smaller exploration or execution budget' },
  { id: 'standard', label: 'Standard', title: 'Use the normal exploration or execution budget' },
  { id: 'deep', label: 'Deep', title: 'Use a larger budget for complex work' },
  { id: 'pilot', label: 'Pilot', title: 'Use an expanded budget for broad implementation or investigation' },
  { id: 'enterprise', label: 'Enterprise', title: 'Use the largest built-in budget for exhaustive work' },
];

export function ChatInput({
  loading,
  mode,
  approvalMode,
  activeDepth,
  tokenUsage,
  pinnedContext,
  canRetry,
  onSend,
  onStop,
  onModeChange,
  onApprovalModeChange,
  onDepthChange,
  onRetry,
  onCopyResponse,
  onCopyChatHistory,
  canCopyChatHistory = false,
  onAddPinned,
  onSearchPaths,
  pathSuggestions,
  pathSearchRequestId,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [searchRequestId, setSearchRequestId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0];
  const activeApproval =
    APPROVAL_MODE_OPTIONS.find((option) => option.id === approvalMode) ?? APPROVAL_MODE_OPTIONS[0];
  const selectedDepth = DEPTH_OPTIONS.find((option) => option.id === activeDepth) ?? DEPTH_OPTIONS[0];

  useEffect(() => {
    if (!searchRequestId || searchRequestId !== pathSearchRequestId) return;
    setMentionIndex(0);
  }, [pathSuggestions, pathSearchRequestId, searchRequestId]);

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionQuery('');
    setMentionStart(null);
    setSearchRequestId(null);
  }, []);

  const applyMention = useCallback(
    (suggestion: ContextPathSuggestion) => {
      if (mentionStart === null) return;
      const before = value.slice(0, mentionStart);
      const after = value.slice(textareaRef.current?.selectionStart ?? mentionStart + mentionQuery.length + 1);
      const tag = `@${suggestion.path}`;
      const next = `${before}${tag} ${after}`;
      setValue(next);
      onAddPinned(suggestion.path, suggestion.kind);
      closeMention();
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [closeMention, mentionQuery.length, mentionStart, onAddPinned, value]
  );

  const updateMentionState = useCallback(
    (nextValue: string, cursor: number) => {
      const beforeCursor = nextValue.slice(0, cursor);
      const atMatch = beforeCursor.match(/@([\w./_-]*)$/);
      if (!atMatch) {
        closeMention();
        return;
      }
      const query = atMatch[1] ?? '';
      const start = cursor - query.length - 1;
      setMentionOpen(true);
      setMentionQuery(query);
      setMentionStart(start);
      if (query.length >= 1) {
        const requestId = `mention-${Date.now()}`;
        setSearchRequestId(requestId);
        onSearchPaths(query, requestId);
      }
    },
    [closeMention, onSearchPaths]
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    onSend(trimmed, pinnedContext);
    setValue('');
    closeMention();
  }, [value, loading, onSend, pinnedContext, closeMention]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && pathSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % pathSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + pathSuggestions.length) % pathSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const picked = pathSuggestions[mentionIndex];
        if (picked) applyMention(picked);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="composer">
      <div className="composer__box">
        {mentionOpen && (
          <div className="mention-picker" role="listbox" aria-label="Context path suggestions">
            {pathSuggestions.length === 0 ? (
              <div className="mention-picker__empty">
                {mentionQuery.length < 1 ? 'Type to search files and folders…' : 'No matches'}
              </div>
            ) : (
              pathSuggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.kind}:${suggestion.path}`}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  className={`mention-picker__item${index === mentionIndex ? ' mention-picker__item--active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(suggestion);
                  }}
                >
                  <span className="mention-picker__icon">{suggestion.kind === 'folder' ? '📁' : '📄'}</span>
                  <span className="mention-picker__label">{suggestion.label}</span>
                </button>
              ))
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="composer__input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            updateMentionState(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) =>
            updateMentionState(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? e.currentTarget.value.length
            )
          }
          onKeyDown={handleKeyDown}
          placeholder="Ask anything… use @ to add files or folders"
          disabled={loading}
          rows={3}
          aria-label="Chat message input"
        />
        <div className="composer__footer">
          <div className="composer__left">
            <div className="composer__mode-select-wrap">
              <select
                className="composer__mode-select"
                value={mode}
                onChange={(e) => onModeChange(e.target.value as ThunderMode)}
                aria-label="Agent mode"
                title={activeMode.description}
              >
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <IconChevronDown className="composer__mode-chevron" width={12} height={12} aria-hidden />
            </div>
            <div className="composer__mode-select-wrap">
              <select
                className="composer__mode-select composer__approval-select"
                value={approvalMode}
                onChange={(e) => onApprovalModeChange(e.target.value as ApprovalMode)}
                aria-label="Approval policy"
                title={activeApproval.title}
              >
                {APPROVAL_MODE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <IconChevronDown className="composer__mode-chevron" width={12} height={12} aria-hidden />
            </div>
            <div className="composer__mode-select-wrap">
              <select
                className="composer__mode-select composer__depth-select"
                value={activeDepth}
                onChange={(e) => onDepthChange(e.target.value as AgentDepthView)}
                aria-label="Agent depth"
                title={selectedDepth.title}
              >
                {DEPTH_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <IconChevronDown className="composer__mode-chevron" width={12} height={12} aria-hidden />
            </div>
            <TokenMeter usage={tokenUsage} compact placement="above" />
          </div>
          <div className="composer__actions">
            {onRetry && (
              <IconButton label="Retry last message" variant="ghost" onClick={onRetry} disabled={loading || !canRetry}>
                <IconRetry />
              </IconButton>
            )}
            {onCopyResponse && (
              <IconButton label="Copy last response" variant="ghost" onClick={onCopyResponse} disabled={loading}>
                <IconCopy />
              </IconButton>
            )}
            {onCopyChatHistory && (
              <IconButton
                label="Copy chat as Markdown"
                variant="ghost"
                onClick={onCopyChatHistory}
                disabled={!canCopyChatHistory}
              >
                <IconMarkdown />
              </IconButton>
            )}
            {loading ? (
              <IconButton label="Stop generation" variant="accent" onClick={onStop}>
                <IconStop />
              </IconButton>
            ) : (
              <IconButton
                label="Send message"
                variant="accent"
                onClick={handleSend}
                disabled={!value.trim()}
              >
                <IconSend />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
