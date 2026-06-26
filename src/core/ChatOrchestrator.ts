import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { ThunderDb } from './indexing/ThunderDb';
import type { LlmProvider } from './llm/types';
import type { ThunderSession } from './ThunderSession';
import type { ContextItem } from './context/types';
import type { ContextItemView, PlanView } from '../vscode/webview/messages';
import { HybridRetriever } from './context/HybridRetriever';
import { ContextBudgeter } from './context/ContextBudgeter';
import { buildPrompt } from './planning/promptBuilder';
import { parsePlanFromText } from './planning/PlanActEngine';
import { createLogger } from './telemetry/Logger';

const log = createLogger('ChatOrchestrator');

export type ContextPackCallback = (items: ContextItem[], totalTokens: number) => void;
export type PlanCallback = (plan: PlanView | null) => void;

export class ChatOrchestrator {
  private abortController: AbortController | undefined;
  private onContextPack: ContextPackCallback | undefined;
  private onPlan: PlanCallback | undefined;

  constructor(
    private readonly retriever: HybridRetriever,
    private readonly budgeter: ContextBudgeter,
    private readonly db?: ThunderDb
  ) {}

  setContextPackCallback(cb: ContextPackCallback): void {
    this.onContextPack = cb;
  }

  setPlanCallback(cb: PlanCallback): void {
    this.onPlan = cb;
  }

  async *send(
    session: ThunderSession,
    provider: LlmProvider,
    userMessage: string
  ): AsyncIterable<string> {
    this.abortController = new AbortController();

    const editor = vscode.window.activeTextEditor;
    const currentFile = editor
      ? vscode.workspace.asRelativePath(editor.document.uri)
      : undefined;

    const items = await this.retriever.retrieve({
      text: userMessage,
      currentFile,
      maxItems: 30,
    });

    const config = provider.capabilities;
    const pack = this.budgeter.budget(items, Math.floor(config.contextWindow * 0.6));
    this.onContextPack?.(pack.items, pack.totalTokens);

    const messages = buildPrompt(session.mode, pack, userMessage);
    this.saveTurn(session.id, 'user', userMessage);

    let fullResponse = '';
    try {
      for await (const delta of provider.complete({ messages, stream: true })) {
        if (this.abortController.signal.aborted) break;
        if (delta.content) {
          fullResponse += delta.content;
          yield delta.content;
        }
        if (delta.error) throw new Error(delta.error);
      }
    } finally {
      if (fullResponse) {
        this.saveTurn(session.id, 'assistant', fullResponse);
        const parsed = parsePlanFromText(fullResponse);
        if (parsed) {
          this.onPlan?.({
            goal: parsed.goal,
            assumptions: parsed.assumptions,
            steps: parsed.steps,
          });
        }
      }
    }

    log.info('Chat completed', { sessionId: session.id, tokens: pack.totalTokens });
  }

  stop(): void {
    this.abortController?.abort();
  }

  private saveTurn(sessionId: string, role: string, content: string): void {
    if (!this.db) return;
    try {
      this.db.raw.prepare(`
        INSERT INTO agent_turns (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), sessionId, role, content, Date.now());
    } catch {
      // Session may not exist in DB yet
    }
  }
}

export function contextItemsToViews(items: ContextItem[]): ContextItemView[] {
  return items.map((item) => ({
    id: item.id,
    source: item.source,
    relPath: item.relPath,
    reason: item.reason,
    tokenEstimate: item.tokenEstimate,
    preview: item.content.slice(0, 200),
  }));
}
