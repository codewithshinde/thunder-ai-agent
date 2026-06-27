import { useVsCodeMessaging } from './state/useVsCodeMessaging';
import { MessageList } from './components/MessageList';
import { ChatInput } from './components/ChatInput';
import { ErrorBanner } from './components/ErrorBanner';
import { SettingsPanel } from './components/SettingsPanel';
import { ApprovalCards } from './components/ApprovalCards';
import { IndexingStatusBar } from './components/IndexingStatusBar';
import { WorkspaceBanner } from './components/WorkspaceBanner';
import { TokenMeter } from './components/TokenMeter';
import { HistoryPanel } from './components/HistoryPanel';
import { IconButton } from './components/IconButton';
import { IconChat, IconHistory, IconPlus, IconSettings } from './components/Icons';

export function App() {
  const { state, postMessage } = useVsCodeMessaging();
  const canRetry = state.messages.some((m) => m.role === 'user');

  return (
    <div className="thunder-app">
      <header className="thunder-toolbar">
        <div className="toolbar-brand">
          <span className="thunder-logo" aria-hidden="true">⚡</span>
          <span className="toolbar-provider" title={state.providerLabel}>
            {state.providerLabel}
          </span>
        </div>
        <nav className="toolbar-nav" role="tablist" aria-label="Main navigation">
          {state.tab === 'chat' && (
            <IconButton
              label="New chat"
              onClick={() => postMessage({ type: 'newChat' })}
              className="toolbar-new-chat"
            >
              <IconPlus />
            </IconButton>
          )}
          <IconButton
            label="Chat"
            active={state.tab === 'chat'}
            onClick={() => postMessage({ type: 'setTab', payload: 'chat' })}
          >
            <IconChat />
          </IconButton>
          <IconButton
            label="History"
            active={state.tab === 'history'}
            onClick={() => postMessage({ type: 'setTab', payload: 'history' })}
          >
            <IconHistory />
          </IconButton>
          <IconButton
            label="Settings"
            active={state.tab === 'settings'}
            onClick={() => postMessage({ type: 'setTab', payload: 'settings' })}
          >
            <IconSettings />
          </IconButton>
        </nav>
        <div className="toolbar-meta">
          <IndexingStatusBar
            status={state.indexing}
            onIndex={() => postMessage({ type: 'indexWorkspace' })}
          />
          <TokenMeter usage={state.tokenUsage} compact />
        </div>
      </header>

      <ErrorBanner
        error={state.error}
        onRetry={() => postMessage({ type: 'retryLastMessage' })}
        onSettings={() => postMessage({ type: 'setTab', payload: 'settings' })}
        onDismiss={() => postMessage({ type: 'clearError' })}
      />

      <WorkspaceBanner
        workspaceOpen={state.workspaceOpen}
        workspacePath={state.workspacePath}
        vscodeWorkspaceFolders={state.vscodeWorkspaceFolders}
        usingWorkspaceOverride={state.usingWorkspaceOverride}
        indexed={state.indexing.indexed}
      />

      <ApprovalCards
        approvals={state.approvals}
        onResolve={(id, decision, selectedOption) =>
          postMessage({ type: 'resolveApproval', payload: { id, decision, selectedOption } })
        }
        onApproveAll={() => postMessage({ type: 'approveAllPending' })}
      />

      {state.tab === 'chat' ? (
        <div className="chat-shell">
          <div className="chat-body">
            <MessageList
              messages={state.messages}
              loading={state.loading}
              agentActivity={state.agentActivity}
              approvals={state.approvals}
            />
          </div>
          <footer className="chat-footer">
            <ChatInput
              loading={state.loading}
              mode={state.mode}
              tokenUsage={state.tokenUsage}
              canRetry={canRetry}
              onSend={(content) => postMessage({ type: 'sendMessage', payload: { content } })}
              onStop={() => postMessage({ type: 'stopGeneration' })}
              onModeChange={(mode) => postMessage({ type: 'setMode', payload: mode })}
              onRetry={() => postMessage({ type: 'retryLastMessage' })}
              onCopyResponse={() => postMessage({ type: 'copyLastResponse' })}
            />
          </footer>
        </div>
      ) : state.tab === 'history' ? (
        <HistoryPanel
          threads={state.chatHistory}
          onOpen={(id) => postMessage({ type: 'openChatThread', payload: { id } })}
        />
      ) : (
        <main className="thunder-main settings-view">
          <SettingsPanel
            settings={state.settings}
            workspaceOpen={state.workspaceOpen}
            workspacePath={state.workspacePath}
            vscodeWorkspaceFolders={state.vscodeWorkspaceFolders}
            workspaceOverride={state.workspaceOverride}
            usingWorkspaceOverride={state.usingWorkspaceOverride}
            indexDbPath={state.indexDbPath}
            indexed={state.indexing.indexed}
            indexingRunning={state.indexing.running}
            workspaceNotice={state.workspaceNotice}
            contextToggles={state.contextToggles}
            onSaveApiKey={(key) => postMessage({ type: 'saveApiKey', payload: { key } })}
            onSaveProviderSettings={(payload) =>
              postMessage({ type: 'saveProviderSettings', payload })
            }
            onSaveAgentSettings={(payload) =>
              postMessage({ type: 'saveAgentSettings', payload })
            }
            onTestConnection={(payload) => postMessage({ type: 'testProviderConnection', payload })}
            onPickWorkspaceFolder={() => postMessage({ type: 'pickWorkspaceFolder' })}
            onSetWorkspaceOverride={(path) =>
              postMessage({ type: 'setWorkspaceOverride', payload: { path } })
            }
            onClearWorkspaceOverride={() => postMessage({ type: 'clearWorkspaceOverride' })}
            onIndex={() => postMessage({ type: 'indexWorkspace' })}
            onToggleContext={(source, enabled) =>
              postMessage({ type: 'toggleContextSource', payload: { source, enabled } })
            }
          />
        </main>
      )}
    </div>
  );
}
