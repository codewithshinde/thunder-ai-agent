import type { AskScopeResolution, ProjectCatalog, ProjectNode } from './askTypes';

const TYPE_KEYWORDS: Record<ProjectNode['type'], RegExp> = {
  extension: /\b(extension|vscode|sidebar|agent)\b/i,
  docs: /\b(docs?|documentation|docusaurus|mdx)\b/i,
  web: /\b(web|website|frontend|site|next|vite)\b/i,
  lib: /\b(lib|library|package|sdk)\b/i,
  service: /\b(api|server|service|backend)\b/i,
  unknown: /\b(project|app|workspace)\b/i,
};

export function resolveAskScope(userMessage: string, catalog?: ProjectCatalog): AskScopeResolution {
  const projects = catalog?.projects ?? [];
  if (projects.length === 0) {
    return { status: 'none', projects: [], reason: 'No workspace project catalog is available.' };
  }

  const text = userMessage.toLowerCase();
  const scored = projects
    .map((project) => ({ project, score: scoreProject(project, text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.project.root.localeCompare(b.project.root));

  if (/\b(across|between|all projects|monorepo|relate|relationship)\b/i.test(userMessage)) {
    return {
      status: 'all',
      projects: scored.length > 1 ? scored.map((entry) => entry.project) : projects,
      reason: 'Question asks across multiple projects.',
    };
  }

  if (scored.length === 0) {
    return {
      status: projects.length === 1 ? 'matched' : 'all',
      projects: projects.length === 1 ? [projects[0]] : projects,
      scopeRoot: projects.length === 1 ? projects[0].root : undefined,
      reason: projects.length === 1
        ? 'Only one project was detected.'
        : 'No explicit project scope matched; use all projects unless the model needs clarification.',
    };
  }

  const [first, second] = scored;
  if (second && first.score === second.score && first.score < 8) {
    return {
      status: 'ambiguous',
      projects: scored.slice(0, 5).map((entry) => entry.project),
      reason: 'Multiple projects match the requested scope.',
    };
  }

  return {
    status: 'matched',
    projects: [first.project],
    scopeRoot: first.project.root,
    reason: `Matched project "${first.project.id}" from the question.`,
  };
}

function scoreProject(project: ProjectNode, lowerText: string): number {
  let score = 0;
  const aliases = [
    project.id,
    project.name,
    project.root,
    project.root.split('/').at(-1) ?? '',
  ]
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  for (const alias of aliases) {
    if (!alias || alias === '.') continue;
    if (lowerText.includes(alias)) score += alias.length > 3 ? 8 : 4;
  }

  if (TYPE_KEYWORDS[project.type].test(lowerText)) score += 5;
  return score;
}
