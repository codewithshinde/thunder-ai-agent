import type { TaskAnalysis } from '../../runtime/TaskAnalyzer';
import type { SkillCatalogService } from '../../skills/SkillCatalogService';
import type { ActIntent } from './actTypes';

const MAX_SKILL_CHARS = 24_000;

export function resolveActSkillNames(intent: ActIntent, taskAnalysis?: TaskAnalysis): string[] {
  const names: string[] = ['using-agent-skills'];

  if (intent === 'audit' || taskAnalysis?.kind === 'audit') {
    names.push('audit-cleanup');
  }

  if (
    intent === 'resume_plan' ||
    intent === 'bugfix' ||
    intent === 'mdx_repair' ||
    /\b(error|failing|failed|debug|repair|fix)\b/i.test(taskAnalysis?.summary ?? '')
  ) {
    names.push('debugging-and-error-recovery');
  }

  if (
    intent === 'feature' ||
    intent === 'refactor' ||
    intent === 'docs' ||
    taskAnalysis?.kind === 'implementation' ||
    taskAnalysis?.kind === 'explicit_plan'
  ) {
    names.push('test-driven-development');
  }

  return [...new Set(names)];
}

export function loadActSkillPlaybooks(
  catalog: SkillCatalogService | undefined,
  skillNames: string[]
): { context: string; loaded: string[] } {
  if (!catalog || skillNames.length === 0) return { context: '', loaded: [] };

  const loaded: string[] = [];
  const blocks: string[] = [];
  let totalChars = 0;

  for (const name of skillNames) {
    const skill = catalog.get(name);
    if (!skill) continue;

    const block = [
      `### Skill: ${skill.entry.name}`,
      `Path: ${skill.entry.relPath}`,
      skill.content.trim(),
    ].join('\n\n');

    if (totalChars + block.length > MAX_SKILL_CHARS) break;
    blocks.push(block);
    loaded.push(skill.entry.name);
    totalChars += block.length;
  }

  if (blocks.length === 0) return { context: '', loaded: [] };

  return {
    context: [
      '## Act skill playbooks (follow these workflows)',
      'These playbooks were pre-loaded for this execution session. Use them to guide implementation, debugging, verification, and recovery.',
      '',
      blocks.join('\n\n---\n\n'),
    ].join('\n'),
    loaded,
  };
}

export const ACT_SKILL_TOOL_GUIDANCE = `
ACT SKILLS:
- Call use_skill to load a workspace playbook when the task needs a workflow that is not already injected.
- For bug fixes and failed verification, use debugging-and-error-recovery.
- For implementation and refactors, use test-driven-development when tests or verification strategy are unclear.
- For cleanup tasks, use audit-cleanup and prefer repository audit scripts over manual grep.`;
