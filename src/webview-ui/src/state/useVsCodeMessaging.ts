import { useCallback, useEffect, useReducer } from 'react';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../vscode/webview/messages';
import { initialState, webviewReducer } from './store';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : undefined;

export function useVsCodeMessaging() {
  const [state, dispatch] = useReducer(webviewReducer, initialState);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'state':
          dispatch({ type: 'SET_STATE', payload: message.payload });
          break;
        case 'appendMessage':
          dispatch({ type: 'APPEND_MESSAGE', payload: message.payload });
          break;
        case 'updateLastAssistant':
          dispatch({ type: 'UPDATE_LAST_ASSISTANT', payload: message.payload });
          break;
        case 'setError':
          dispatch({ type: 'SET_ERROR', payload: message.payload });
          break;
        case 'setLoading':
          dispatch({ type: 'SET_LOADING', payload: message.payload });
          break;
        case 'setMode':
          dispatch({ type: 'SET_MODE', payload: message.payload });
          break;
        case 'setTab':
          dispatch({ type: 'SET_TAB', payload: message.payload });
          break;
        case 'setIndexing':
          dispatch({ type: 'SET_INDEXING', payload: message.payload });
          break;
        case 'setApprovals':
          dispatch({ type: 'SET_APPROVALS', payload: message.payload });
          break;
        case 'setContextPreview':
          dispatch({ type: 'SET_CONTEXT_PREVIEW', payload: message.payload });
          break;
        case 'setPlan':
          dispatch({ type: 'SET_PLAN', payload: message.payload });
          break;
        case 'setAgentActivity':
          dispatch({ type: 'SET_AGENT_ACTIVITY', payload: message.payload });
          break;
        case 'setAgentLiveStatus':
          dispatch({ type: 'SET_AGENT_LIVE_STATUS', payload: message.payload });
          break;
        case 'setSubagents':
          dispatch({ type: 'SET_SUBAGENTS', payload: message.payload });
          break;
      }
    };

    window.addEventListener('message', handler);
    postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const postMessage = useCallback((message: WebviewToExtensionMessage) => {
    vscode?.postMessage(message);
  }, []);

  return { state, dispatch, postMessage };
}
