import { useState, useEffect } from 'react';
import { AGENT_NAME } from '../../shared/brand';
import { useVsCodeMessaging } from './state/useVsCodeMessaging';
import { MessageList } from './components/MessageList';
import { ChatInput } from './components/ChatInput';
import { ContextPanel } from './components/ContextPanel';
import { ContextWarningBanner } from './components/ContextWarningBanner';
import { ErrorBanner } from './components/ErrorBanner';
import { SettingsPanel } from './components/SettingsPanel';
import { ApprovalCards } from './components/ApprovalCards';
import { IndexingStatusBar } from './components/IndexingStatusBar';
import { WorkspaceBanner } from './components/WorkspaceBanner';
import { HistoryPanel } from './components/HistoryPanel';
import { PlanPanel } from './components/PlanPanel';
import { DevPanels } from './components/DevPanels';
import { IconButton } from './components/IconButton';
import { IconChat, IconHistory, IconPlus, IconSettings } from './components/Icons';
import { deriveSafetySettings } from './utils/approvalMode';
import type { AgentDepthView, AgentSettingsPayload, SettingsView } from '../../vscode/webview/messages';
import type { ThunderMode } from '../../core/session/ThunderSession';

function activeDepthForMode(settings: SettingsView, mode: ThunderMode): AgentDepthView {
  if (mode === 'ask') return settings.askDepth;
  if (mode === 'agent') return settings.actDepth;
  return settings.planDepth;
}

function buildAgentSettingsPayload(settings: SettingsView, depthPatch: Partial<Pick<AgentSettingsPayload, 'askDepth' | 'planDepth' | 'actDepth'>> = {}): AgentSettingsPayload {
  return {
    subagentsEnabled: settings.subagentsEnabled,
    maxSteps: settings.agentMaxSteps,
    askDepth: settings.askDepth,
    planDepth: settings.planDepth,
    actDepth: settings.actDepth,
    askMaxSteps: settings.askMaxSteps,
    askAutoContinue: settings.askAutoContinue,
    askMaxAutoContinues: settings.askMaxAutoContinues,
    autoContinue: settings.agentAutoContinue,
    maxAutoContinues: settings.agentMaxAutoContinues,
    researchAgentMaxSteps: settings.researchAgentMaxSteps,
    showDiffPreview: settings.showDiffPreview,
    planModel: settings.planModel,
    planBaseUrl: settings.planBaseUrl,
    actModel: settings.actModel,
    actBaseUrl: settings.actBaseUrl,
    checkpointStrategy: settings.checkpointStrategy,
    ...depthPatch,
  };
}

export function App() {
  const { state, postMessage, pathSuggestions, pathSearchRequestId } = useVsCodeMessaging();
  const canRetry = state.messages.some((m) => m.role === 'user');
  const [contextWarningsDismissed, setContextWarningsDismissed] = useState(false);
  const activeDepth = activeDepthForMode(state.settings, state.mode);

  useEffect(() => {
    setContextWarningsDismissed(false);
  }, [state.contextBudget?.dropped.length, state.indexing.indexed, state.indexing.total]);

  return (
    <div className="thunder-app">
      <header className="thunder-toolbar">
        <div className="toolbar-brand">
          {state.logoUri ? (
            <img
              className="thunder-logo"
              src={state.logoUri}
              alt={`${AGENT_NAME} logo`}
              width={20}
              height={20}
            />
          ) : (
            <span className="thunder-logo thunder-logo--fallback" aria-hidden="true">◆</span>
          )}
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
        workspaceTrusted={state.workspaceTrusted}
      />

      {!contextWarningsDismissed && (
        <ContextWarningBanner
          budget={state.contextBudget}
          indexing={state.indexing}
          onDismiss={() => setContextWarningsDismissed(true)}
        />
      )}

      <ApprovalCards
        approvals={state.approvals}
        onResolve={(id, decision, selectedOption, scope) =>
          postMessage({ type: 'resolveApproval', payload: { id, decision, selectedOption, scope } })
        }
        onApproveAll={() => postMessage({ type: 'approveAllPending' })}
        onShowInlineDiff={(approvalId) =>
          postMessage({ type: 'showInlineDiff', payload: { approvalId } })
        }
      />

      {state.tab === 'chat' ? (
        <div className={`chat-shell ${state.mode === 'plan' ? 'chat-shell--plan-mode' : ''}`}>
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
          <DevPanels
            contextBudget={state.contextBudget}
            contextPreview={state.contextPreview}
            contextTokenEstimate={state.contextTokenEstimate}
            tokenUsage={state.tokenUsage}
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
              approvalMode={state.settings.approvalMode}
              activeDepth={activeDepth}
              tokenUsage={state.tokenUsage}
              pinnedContext={state.pinnedContext}
              canRetry={canRetry}
              onSend={(content, pinnedContext) =>
                postMessage({ type: 'sendMessage', payload: { content, pinnedContext } })
              }
              onStop={() => postMessage({ type: 'stopGeneration' })}
              onModeChange={(mode) => postMessage({ type: 'setMode', payload: mode })}
              onApprovalModeChange={(approvalMode) =>
                postMessage({
                  type: 'saveSafetySettings',
                  payload: deriveSafetySettings(approvalMode),
                })
              }
              onDepthChange={(depth) => {
                const depthPatch =
                  state.mode === 'ask'
                    ? { askDepth: depth }
                    : state.mode === 'agent'
                      ? { actDepth: depth }
                      : { planDepth: depth };
                postMessage({
                  type: 'saveAgentSettings',
                  payload: buildAgentSettingsPayload(state.settings, depthPatch),
                });
              }}
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
            indexing={state.indexing}
            workspaceNotice={state.workspaceNotice}
            contextToggles={state.contextToggles}
            mcpToggles={state.mcpToggles}
            vectorIndex={state.vectorIndex}
            memories={state.memories}
            checkpoints={state.checkpoints}
            onSaveApiKey={(key) => postMessage({ type: 'saveApiKey', payload: { key } })}
            onSaveGitHubToken={(token) => postMessage({ type: 'saveGitHubToken', payload: { token } })}
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
            onToggleMcp={(server, enabled) =>
              postMessage({ type: 'toggleMcpServer', payload: { server, enabled } })
            }
            onSaveCustomMcpServers={(servers) =>
              postMessage({ type: 'saveCustomMcpServers', payload: { servers } })
            }
            onDeleteMemory={(id) => postMessage({ type: 'deleteMemory', payload: { id } })}
            onClearMemory={() => postMessage({ type: 'clearMemory' })}
            onRestoreCheckpoint={(id) => postMessage({ type: 'restoreCheckpoint', payload: { id } })}
          />
        </main>
      )}
    </div>
  );
}
