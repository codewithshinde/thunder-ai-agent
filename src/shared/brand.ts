/**
 * Product branding — display name, domain, and community links.
 *
 * Keep in sync with mitii-docs/brand.ts and mitii-website/brand.ts.
 * Internal extension command IDs still use `thunder.*` for VS Code compatibility.
 */
export const AGENT_NAME = 'Mitii';
export const AGENT_FULL_NAME = 'Mitii AI Agent';
export const AGENT_DOMAIN = 'mitii.dev';
export const WEBSITE_URL = 'https://mitii.dev';
export const DOCS_URL = 'https://docs.mitii.dev';
export const AGENT_TAGLINE =
  'Your local-first AI coding agent for complex work. Read files, write code, run commands — all with your approval.';
export const AGENT_DESCRIPTION =
  'Local-first VS Code AI coding agent with precise repo context and safe Plan/Act workflow.';

export const GITHUB_URL = 'https://github.com/codewithshinde/thunder-ai-agent';
export const GITHUB_ISSUES_URL = 'https://github.com/codewithshinde/thunder-ai-agent/issues';
export const DOCS_REPO_URL = 'https://github.com/codewithshinde/mitii-docs';
export const WEBSITE_REPO_URL = 'https://github.com/codewithshinde/mitii-website';
export const DISCORD_URL = 'https://discord.gg/sa8rubf6HH';

export const AUTHOR_NAME = 'codewithshinde';
export const AUTHOR_GITHUB_URL = 'https://github.com/codewithshinde';
export const AUTHOR_EMAIL = 'codewithshinde@gmail.com';

export const LOGO_EMOJI = '◆';

/** VS Code notification / status bar prefix, e.g. "Mitii: Settings saved." */
export function brandMessage(message: string): string {
  return `${AGENT_NAME}: ${message}`;
}
