import type { AskScopeResolution, ProjectCatalog } from '../ask/askTypes';
import { formatProjectCatalog } from '../ask/ProjectCatalog';
import { formatVerifyPlanForAgent, resolveProjectVerifyCommands } from '../../runtime/verifyCommandDiscovery';
import type { ActRoute } from './actTypes';

export function buildActPromptContext(
  userMessage: string,
  route: ActRoute,
  scope: AskScopeResolution,
  catalog?: ProjectCatalog,
  options: {
    appliedSkills?: string[];
    suggestedSkills?: string[];
    savedPlanId?: string;
    verifyCommands?: string[];
    workspaceRoot?: string;
  } = {}
): string {
  const lines = [
    '## Act routing',
    `Intent: ${route.intent}`,
    `Execution path: ${route.executionPath}`,
    `Complexity: ${route.complexity}`,
    `Verify required: ${route.shouldVerify ? 'yes' : 'no'}`,
    `Summary: ${route.summary}`,
    '',
    '## Act workflow contract',
    '- Read or search relevant files before writing.',
    '- Keep edits scoped to the user request, active plan, and touched files.',
    '- Prefer targeted patches and preserve unrelated user changes.',
    '- Run project-appropriate verification after implementation (discovered from package.json, not hardcoded).',
  ];

  if (route.executionPath === 'resume_saved_plan') {
    lines.push(
      '',
      '## Saved plan handoff',
      options.savedPlanId
        ? `Resume active plan ${options.savedPlanId}. Do not replan unless the saved plan is impossible to execute.`
        : 'Resume the active saved plan. Do not replan unless the saved plan is impossible to execute.'
    );
  }

  lines.push(
    '',
    '## Scope',
    `Status: ${scope.status}`,
    `Reason: ${scope.reason}`,
  );
  if (scope.scopeRoot) lines.push(`Scope root: ${scope.scopeRoot}`);

  if (options.suggestedSkills?.length) {
    lines.push('', `Suggested skills: ${options.suggestedSkills.join(', ')}`);
  }
  if (options.appliedSkills?.length) {
    lines.push(`Applied skills: ${options.appliedSkills.join(', ')}`);
  }

  if (options.workspaceRoot) {
    const plan = resolveProjectVerifyCommands(
      options.workspaceRoot,
      options.verifyCommands ?? [],
      { userMessage }
    );
    lines.push('', formatVerifyPlanForAgent(plan));
  }

  if (catalog) {
    lines.push('', formatProjectCatalog(catalog));
  }

  lines.push('', '## Original Act request', userMessage);
  return lines.join('\n');
}
