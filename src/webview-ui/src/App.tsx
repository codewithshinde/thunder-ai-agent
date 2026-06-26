import { useVsCodeMessaging } from './state/useVsCodeMessaging';
import { MessageList } from './components/MessageList';
import { ChatInput } from './components/ChatInput';
import { ModeIndicator } from './components/ModeIndicator';
import { ErrorBanner } from './components/ErrorBanner';
import { SettingsPanel } from './components/SettingsPanel';
import { ApprovalCards } from './components/ApprovalCards';
import { ContextPreview } from './components/ContextPreview';
import { PlanPanel } from './components/PlanPanel';
import { IndexingStatusBar } from './components/IndexingStatusBar';
import { MemoryPanel } from './components/MemoryPanel';
import { CheckpointPanel } from './components/CheckpointPanel';
import { ContextTogglesPanel } from './components/ContextTogglesPanel';

export function App() {
  const { state, postMessage } = useVsCodeMessaging();

  return (
    <div className="thunder-app">
      <header className="thunder-header">
        <div className="thunder-brand">
          <span className="thunder-logo" aria-hidden="true">⚡</span>
          <h1 className="thunder-title">Thunder AI Agent</h1>
        </div>
        <nav className="thunder-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`tab-btn ${state.tab === 'chat' ? 'tab-btn--active' : ''}`}
            aria-selected={state.tab === 'chat'}
            onClick={() => postMessage({ type: 'setTab', payload: 'chat' })}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            className={`tab-btn ${state.tab === 'settings' ? 'tab-btn--active' : ''}`}
            aria-selected={state.tab === 'settings'}
            onClick={() => postMessage({ type: 'setTab', payload: 'settings' })}
          >
            Settings
          </button>
        </nav>
        <IndexingStatusBar
          status={state.indexing}
          onIndex={() => postMessage({ type: 'indexWorkspace' })}
        />
      </header>

      <ErrorBanner error={state.error} onDismiss={() => postMessage({ type: 'clearError' })} />

      <ApprovalCards
        approvals={state.approvals}
        onResolve={(id, decision) => postMessage({ type: 'resolveApproval', payload: { id, decision } })}
      />

      {state.tab === 'chat' ? (
        <>
          <ModeIndicator
            mode={state.mode}
            onChange={(mode) => postMessage({ type: 'setMode', payload: mode })}
          />
          <ContextTogglesPanel
            toggles={state.contextToggles}
            onToggle={(source, enabled) =>
              postMessage({ type: 'toggleContextSource', payload: { source, enabled } })
            }
          />
          <ContextPreview
            items={state.contextPreview}
            totalTokens={state.contextTokenEstimate}
            visible={state.showContextPreview}
            onToggle={() => postMessage({ type: 'toggleContextPreview' })}
          />
          <PlanPanel plan={state.plan} />
          <main className="thunder-main">
            <MessageList messages={state.messages} />
          </main>
          <div className="side-panels">
            <MemoryPanel
              memories={state.memories}
              onDelete={(id) => postMessage({ type: 'deleteMemory', payload: { id } })}
              onClear={() => postMessage({ type: 'clearMemory' })}
            />
            <CheckpointPanel
              checkpoints={state.checkpoints}
              onRestore={(id) => postMessage({ type: 'restoreCheckpoint', payload: { id } })}
            />
          </div>
          <footer className="thunder-footer">
            <div className="footer-actions">
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => postMessage({ type: 'copyLastResponse' })}
              >
                Copy response
              </button>
            </div>
            <ChatInput
              loading={state.loading}
              onSend={(content) => postMessage({ type: 'sendMessage', payload: { content } })}
              onStop={() => postMessage({ type: 'stopGeneration' })}
            />
          </footer>
        </>
      ) : (
        <main className="thunder-main">
          <SettingsPanel
            settings={state.settings}
            onSaveApiKey={(key) => postMessage({ type: 'saveApiKey', payload: { key } })}
            onIndex={() => postMessage({ type: 'indexWorkspace' })}
          />
        </main>
      )}
    </div>
  );
}
