import type { AskRoute, AskScopeResolution, ProjectCatalog } from './askTypes';
import { formatProjectCatalog } from './ProjectCatalog';

export function buildAskPromptContext(
  userMessage: string,
  route: AskRoute,
  scope: AskScopeResolution,
  catalog?: ProjectCatalog
): string {
  const lines = [
    '## Ask routing',
    `Intent: ${route.intent}`,
    `Response profile: ${route.profile}`,
    `Include impact analysis: ${route.includeImpact ? 'yes' : 'no'}`,
    `External docs allowed when needed: ${route.allowWeb ? 'yes' : 'no'}`,
    `Scope status: ${scope.status}`,
    `Scope reason: ${scope.reason}`,
  ];

  if (scope.projects.length > 0) {
    lines.push(`Scoped projects: ${scope.projects.map((project) => `${project.id} (${project.root})`).join(', ')}`);
  }

  if (catalog) {
    lines.push('', formatProjectCatalog(catalog));
  }

  lines.push('', '## Ask response contract');
  if (route.profile === 'concise') {
    lines.push(
      'Use the concise profile: answer directly, cite read files as `path:line`, and include "What I could not verify" only when relevant.'
    );
  } else {
    lines.push(
      'Use the deep profile: write a thorough, structured explanation with complete sentences, context, tradeoffs, and citations.',
      'Prefer these sections when relevant: Overview, How it works in this codebase, Key files and responsibilities, Data/control flow, Edge cases and gotchas, What I could not verify.'
    );
  }

  if (route.intent === 'implement_here') {
    lines.push(
      '',
      'For implement_here, stay read-only and always include:',
      '## Implementation approach (for this repo)',
      '## Files likely affected',
      '### Modify / ### Create / ### Verify',
      '## External references when fetch_web was useful',
      '## Ready to build?',
      'Use analyze_change_impact before finalizing affected files.'
    );
  }

  if (scope.status === 'ambiguous') {
    lines.push(
      '',
      'The project scope is ambiguous. Use ask_question with the listed projects before making scoped claims.'
    );
  }

  if (route.intent === 'general_knowledge') {
    lines.push('', 'This is general knowledge; do not force repo grounding unless the user asks about this workspace.');
  }

  lines.push('', `Original Ask request: ${userMessage}`);
  return lines.join('\n');
}

export const ASK_DEEP_RESPONSE_TEMPLATE = `
Deep Ask format:

## Overview
[2-4 sentences setting context]

## How it works in this codebase
[Flow explanation with path:line citations]

## Key files and responsibilities
| File | Role |
|------|------|

## Data / control flow
[Optional text or mermaid]

## Edge cases and gotchas
[Only from actual code or inspected docs]

## What I couldn't verify
[Explicit gaps, omitted if none]

## If you want to implement this
[Read-only implementation guidance or tell the user to switch to Agent mode]
`;
