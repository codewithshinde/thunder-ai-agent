import { useVsCodeMessaging } from './state/useVsCodeMessaging';
import { MessageList } from './components/MessageList';
import { ChatInput } from './components/ChatInput';
import { ContextPanel } from './components/ContextPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { SettingsPanel } from './components/SettingsPanel';
import { ApprovalCards } from './components/ApprovalCards';
import { IndexingStatusBar } from './components/IndexingStatusBar';
import { WorkspaceBanner } from './components/WorkspaceBanner';
import { HistoryPanel } from './components/HistoryPanel';
import { PlanPanel } from './components/PlanPanel';
import { IconButton } from './components/IconButton';
import { IconChat, IconHistory, IconPlus, IconSettings } from './components/Icons';

export function App() {
  const { state, postMessage, pathSuggestions, pathSearchRequestId } = useVsCodeMessaging();
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
        onResolve={(id, decision, selectedOption, scope) =>
          postMessage({ type: 'resolveApproval', payload: { id, decision, selectedOption, scope } })
        }
        onApproveAll={() => postMessage({ type: 'approveAllPending' })}
      />

      {state.tab === 'chat' ? (
        <div className="chat-shell">
          <PlanPanel
            plan={state.plan}
            mode={state.mode}
            loading={state.loading}
            liveStatus={state.agentLiveStatus}
          />
          <ContextPanel
            items={state.pinnedContext}
            onRemove={(path) => postMessage({ type: 'removePinnedContext', payload: { path } })}
            onClear={() => postMessage({ type: 'clearPinnedContext' })}
            onPick={() => postMessage({ type: 'pickContextPath' })}
          />
          <div className="chat-body">
            <MessageList
              messages={state.messages}
              loading={state.loading}
              agentActivity={state.agentActivity}
              agentLiveStatus={state.agentLiveStatus}
              approvals={state.approvals}
            />
          </div>
          <footer className="chat-footer">
            <ChatInput
              loading={state.loading}
              mode={state.mode}
              tokenUsage={state.tokenUsage}
              pinnedContext={state.pinnedContext}
              canRetry={canRetry}
              onSend={(content, pinnedContext) =>
                postMessage({ type: 'sendMessage', payload: { content, pinnedContext } })
              }
              onStop={() => postMessage({ type: 'stopGeneration' })}
              onModeChange={(mode) => postMessage({ type: 'setMode', payload: mode })}
              onRetry={() => postMessage({ type: 'retryLastMessage' })}
              onCopyResponse={() => postMessage({ type: 'copyLastResponse' })}
              onCopyChatHistory={() => postMessage({ type: 'copyChatHistoryMarkdown' })}
              canCopyChatHistory={state.messages.some((m) => m.content.trim())}
              onAddPinned={(path, kind) =>
                postMessage({ type: 'addPinnedContext', payload: { path, kind } })
              }
              onSearchPaths={(query, requestId) => {
                postMessage({ type: 'searchContextPaths', payload: { query, requestId } });
              }}
              pathSuggestions={pathSuggestions}
              pathSearchRequestId={pathSearchRequestId}
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
            onSaveAllSettings={(payload) => postMessage({ type: 'saveAllSettings', payload })}
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
