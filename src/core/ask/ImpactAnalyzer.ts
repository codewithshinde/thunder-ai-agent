import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import type { ImpactAnalysis, ImpactFile, ProjectCatalog } from './askTypes';
import { discoverProjectCatalog } from './ProjectCatalog';
import { resolveAskScope } from './AskScopeResolver';

const SKIP_DIRS = new Set(['.git', '.mitii', 'node_modules', 'dist', 'build', 'coverage', '.next', '.docusaurus']);
const ANALYZED_EXT = /\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|mdx?|css|scss)$/i;

export function analyzeChangeImpact(
  workspaceRoot: string,
  feature: string,
  scopeRoot?: string,
  catalog: ProjectCatalog = discoverProjectCatalog(workspaceRoot),
  entrySymbols: string[] = []
): ImpactAnalysis {
  const scope = scopeRoot
    ? catalog.projects.find((project) => project.root === scopeRoot || project.id === scopeRoot)
    : resolveAskScope(feature, catalog).projects[0];
  const root = scope?.root ?? scopeRoot ?? '.';
  const projectRoot = root === '.' ? '' : root;
  const absRoot = join(workspaceRoot, projectRoot);
  const terms = [...extractFeatureTerms(feature), ...entrySymbols.map((symbol) => symbol.toLowerCase())];
  const files = walkFiles(absRoot, projectRoot, 700);
  const scored = scoreFiles(workspaceRoot, files, terms, feature);
  const scripts = scope?.scripts ?? readPackageScripts(absRoot);
  const effectiveRoot = (scope?.root ?? projectRoot) || '.';
  const verify = inferVerifyCommands(workspaceRoot, effectiveRoot, scripts);
  const create = inferCreateFiles(feature, effectiveRoot, scored.modify);
  const maybe = inferMaybeFiles(effectiveRoot, files, feature);

  return {
    summary: summarizeImpact(feature, scope?.id, scored.modify, create),
    projects: scope ? [scope.id] : [],
    files: {
      modify: scored.modify.slice(0, 12),
      create,
      maybe,
      tests: inferTestFiles(files, effectiveRoot),
    },
    dependencies: inferDependencies(feature),
    webReferences: [],
    risks: inferRisks(feature),
    suggestedOrder: inferSuggestedOrder(feature, verify),
  };
}

function scoreFiles(
  workspaceRoot: string,
  files: string[],
  terms: string[],
  feature: string
): { modify: ImpactFile[] } {
  const featureLower = feature.toLowerCase();
  const candidates: ImpactFile[] = [];
  for (const relPath of files) {
    const pathLower = relPath.toLowerCase();
    let content = '';
    try {
      content = readFileSync(join(workspaceRoot, relPath), 'utf8').slice(0, 80_000).toLowerCase();
    } catch {
      continue;
    }

    let score = 0;
    const reasons: string[] = [];
    for (const term of terms) {
      if (pathLower.includes(term)) {
        score += 6;
        reasons.push(`path matches "${term}"`);
      }
      const contentHits = countOccurrences(content, term);
      if (contentHits > 0) {
        score += Math.min(8, contentHits);
        reasons.push(`references "${term}"`);
      }
    }

    if (/\b(route|router|middleware|auth|config|provider|session|controller|service|store|schema)\b/i.test(pathLower)) score += 3;
    if (/package\.json$|\.env|config|settings|test|spec/.test(pathLower)) score += 2;
    if (featureLower.includes('oauth') && /\b(auth|session|token|provider|login)\b/i.test(`${pathLower} ${content}`)) score += 7;
    if (featureLower.includes('rate limit') && /\b(route|middleware|api|server|request)\b/i.test(`${pathLower} ${content}`)) score += 7;

    if (score >= 5) {
      candidates.push({
        path: relPath,
        reason: unique(reasons).slice(0, 3).join('; ') || 'central config or route file for this kind of change',
        confidence: score >= 12 ? 'high' : score >= 8 ? 'medium' : 'low',
      });
    }
  }

  return {
    modify: candidates.sort((a, b) => confidenceWeight(b.confidence) - confidenceWeight(a.confidence) || a.path.localeCompare(b.path)),
  };
}

function inferCreateFiles(feature: string, root: string, modify: ImpactFile[]): ImpactFile[] {
  const base = root === '.' ? 'src' : `${root}/src`;
  const lower = feature.toLowerCase();
  const create: ImpactFile[] = [];
  if (/\boauth|auth|login|session\b/.test(lower)) {
    create.push({ path: `${base}/core/auth/OAuthProvider.ts`, reason: 'new provider/session adapter if no auth module exists', confidence: 'medium' });
  }
  if (/\brate limit|rate-limit|throttl/.test(lower)) {
    create.push({ path: `${base}/middleware/rateLimit.ts`, reason: 'central reusable rate-limiting middleware', confidence: 'medium' });
  }
  if (/\bsdk\b/.test(lower)) {
    create.push({ path: `${root === '.' ? 'packages' : root}/mitii-sdk/src/index.ts`, reason: 'public SDK entry point', confidence: 'low' });
  }
  if (modify.length === 0) {
    create.push({ path: `${base}/feature/${slugFeature(feature)}.ts`, reason: 'no existing implementation surface matched strongly', confidence: 'low' });
  }
  return uniqueByPath(create).slice(0, 5);
}

function inferMaybeFiles(root: string, files: string[], feature: string): ImpactFile[] {
  const packagePath = root === '.' ? 'package.json' : `${root}/package.json`;
  const maybe: ImpactFile[] = [];
  if (files.includes(packagePath)) {
    maybe.push({ path: packagePath, reason: 'scripts, dependencies, or package exports may need updates', confidence: 'medium' });
  }
  for (const relPath of files) {
    if (/\.env(?:\.example)?$|config|settings|README\.md$/i.test(relPath)) {
      maybe.push({ path: relPath, reason: 'configuration or documentation surface for the feature', confidence: 'low' });
    }
  }
  if (/\boauth|api key|token|secret|env\b/i.test(feature) && !maybe.some((file) => file.path.includes('.env'))) {
    maybe.push({ path: root === '.' ? '.env.example' : `${root}/.env.example`, reason: 'document required environment variables', confidence: 'low' });
  }
  return uniqueByPath(maybe).slice(0, 8);
}

function inferTestFiles(files: string[], root: string): string[] {
  const tests = files.filter((file) => /(?:^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./i.test(file));
  if (tests.length > 0) return tests.slice(0, 8);
  return [root === '.' ? 'test/unit.test.ts' : `${root}/test/unit.test.ts`];
}

function inferDependencies(feature: string): string[] {
  const lower = feature.toLowerCase();
  if (/\boauth|openid|oidc\b/.test(lower)) return ['openid-client or provider SDK', 'secure token/session storage'];
  if (/\brate limit|throttl/.test(lower)) return ['rate-limiting middleware or storage adapter'];
  if (/\bstripe\b/.test(lower)) return ['stripe'];
  if (/\bopenai\b/.test(lower)) return ['openai'];
  return [];
}

function inferRisks(feature: string): string[] {
  const lower = feature.toLowerCase();
  const risks = ['Existing public APIs and tests must stay compatible.'];
  if (/\boauth|auth|token|session|secret\b/.test(lower)) {
    risks.push('Token storage, redirect URI validation, and secret handling need careful review.');
  }
  if (/\brate limit|middleware\b/.test(lower)) {
    risks.push('Rate limits can break local/dev workflows if defaults are too aggressive.');
  }
  if (/\bsdk\b/.test(lower)) {
    risks.push('SDK types and streaming events should match the extension behavior.');
  }
  return risks;
}

function inferSuggestedOrder(feature: string, verify: string[]): string[] {
  const steps = [
    'Confirm project scope and read the highest-confidence files.',
    'Add or update the smallest shared abstraction that matches existing patterns.',
    'Wire the feature through callers, config, and UI/API boundaries.',
    'Add focused unit tests and one integration-style coverage point when available.',
  ];
  if (/\boauth|api|sdk|library|latest|current\b/i.test(feature)) {
    steps.splice(1, 0, 'Check current external documentation before choosing package APIs.');
  }
  if (verify.length > 0) steps.push(`Verify with: ${verify.join(' && ')}`);
  return steps;
}

function summarizeImpact(feature: string, projectId: string | undefined, modify: ImpactFile[], create: ImpactFile[]): string {
  const projectText = projectId ? ` in ${projectId}` : '';
  return `Implementing "${feature}"${projectText} likely touches ${modify.length} existing file(s) and ${create.length} new file(s).`;
}

function inferVerifyCommands(workspaceRoot: string, root: string, scripts: Record<string, string>): string[] {
  const prefix = root && root !== '.' ? `cd ${root} && ` : '';
  const runner = detectPackageManager(workspaceRoot, root);
  const preferred = ['test', 'lint', 'typecheck', 'build'];
  return preferred
    .filter((script) => scripts[script])
    .map((script) => `${prefix}${runner} run ${script}`)
    .slice(0, 3);
}

function detectPackageManager(workspaceRoot: string, root: string): 'npm' | 'pnpm' | 'yarn' {
  const absRoot = join(workspaceRoot, root === '.' ? '' : root);
  if (existsSync(join(absRoot, 'pnpm-lock.yaml')) || existsSync(join(workspaceRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(absRoot, 'yarn.lock')) || existsSync(join(workspaceRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function readPackageScripts(absRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(absRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function walkFiles(absRoot: string, relRoot: string, maxFiles: number): string[] {
  const out: string[] = [];
  const visit = (absDir: string, relDir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles || SKIP_DIRS.has(entry)) continue;
      const abs = join(absDir, entry);
      const rel = relDir ? `${relDir}/${entry}` : entry;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(abs, rel);
      } else if (ANALYZED_EXT.test(entry)) {
        out.push(rel);
      }
    }
  };
  if (existsSync(absRoot)) visit(absRoot, relRoot === '.' ? '' : relRoot);
  return out;
}

function extractFeatureTerms(feature: string): string[] {
  const words = feature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return unique(words).slice(0, 10);
}

const STOP_WORDS = new Set([
  'how',
  'would',
  'should',
  'implement',
  'create',
  'build',
  'add',
  'this',
  'that',
  'with',
  'into',
  'here',
  'project',
  'files',
  'change',
]);

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let idx = text.indexOf(term);
  while (idx >= 0 && count < 10) {
    count += 1;
    idx = text.indexOf(term, idx + term.length);
  }
  return count;
}

function confidenceWeight(confidence: ImpactFile['confidence']): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
}

function slugFeature(feature: string): string {
  return basename(feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 40) || 'new-feature';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueByPath(files: ImpactFile[]): ImpactFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}
