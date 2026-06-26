import type { ThunderMode } from '../../../core/ThunderSession';
import type {
  ChatMessage,
  WebviewState,
  WebviewTab,
  ApprovalRequestView,
  ContextItemView,
  PlanView,
  IndexingStatusView,
  AgentActivityEntry,
  AgentLiveStatusView,
  SubagentStatusView,
} from '../../../vscode/webview/messages';
import { initialWebviewState } from '../../../vscode/webview/messages';

export type WebviewAction =
  | { type: 'SET_STATE'; payload: WebviewState }
  | { type: 'APPEND_MESSAGE'; payload: ChatMessage }
  | { type: 'UPDATE_LAST_ASSISTANT'; payload: { content: string; streaming: boolean } }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_MODE'; payload: ThunderMode }
  | { type: 'SET_TAB'; payload: WebviewTab }
  | { type: 'SET_INDEXING'; payload: IndexingStatusView }
  | { type: 'SET_APPROVALS'; payload: ApprovalRequestView[] }
  | { type: 'SET_CONTEXT_PREVIEW'; payload: { items: ContextItemView[]; totalTokens: number } }
  | { type: 'SET_PLAN'; payload: PlanView | null }
  | { type: 'SET_AGENT_ACTIVITY'; payload: AgentActivityEntry[] }
  | { type: 'SET_AGENT_LIVE_STATUS'; payload: AgentLiveStatusView | null }
  | { type: 'SET_SUBAGENTS'; payload: SubagentStatusView[] };

export const initialState: WebviewState = initialWebviewState();

export function webviewReducer(state: WebviewState, action: WebviewAction): WebviewState {
  switch (action.type) {
    case 'SET_STATE': {
      const incoming = action.payload;
      if (state.loading && incoming.loading) {
        const prevLast = state.messages[state.messages.length - 1];
        const nextMessages = incoming.messages;
        const nextLast = nextMessages[nextMessages.length - 1];
        if (
          prevLast?.role === 'assistant' &&
          prevLast.streaming &&
          nextLast?.role === 'assistant' &&
          prevLast.content.length > (nextLast.content?.length ?? 0)
        ) {
          const messages = [...nextMessages];
          messages[messages.length - 1] = {
            ...nextLast,
            content: prevLast.content,
            streaming: true,
          };
          return { ...incoming, messages };
        }
      }
      return incoming;
    }

    case 'APPEND_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload] };

    case 'UPDATE_LAST_ASSISTANT': {
      const messages = [...state.messages];
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: action.payload.content,
          streaming: action.payload.streaming,
        };
      } else {
        messages.push({
          id: `stream-${Date.now()}`,
          role: 'assistant',
          content: action.payload.content,
          timestamp: Date.now(),
          streaming: action.payload.streaming,
        });
      }
      return { ...state, messages };
    }

    case 'SET_ERROR':
      return { ...state, error: action.payload };

    case 'SET_LOADING':
      return { ...state, loading: action.payload };

    case 'SET_MODE':
      return { ...state, mode: action.payload };

    case 'SET_TAB':
      return { ...state, tab: action.payload };

    case 'SET_INDEXING':
      return { ...state, indexing: action.payload };

    case 'SET_APPROVALS':
      return { ...state, approvals: action.payload };

    case 'SET_CONTEXT_PREVIEW':
      return {
        ...state,
        contextPreview: action.payload.items,
        contextTokenEstimate: action.payload.totalTokens,
      };

    case 'SET_PLAN':
      return { ...state, plan: action.payload };

    case 'SET_AGENT_ACTIVITY':
      return { ...state, agentActivity: action.payload };

    case 'SET_AGENT_LIVE_STATUS':
      return { ...state, agentLiveStatus: action.payload };

    case 'SET_SUBAGENTS':
      return { ...state, subagents: action.payload };

    default:
      return state;
  }
}
