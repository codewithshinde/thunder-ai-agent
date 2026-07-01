/** Route MDX/Docusaurus build failures away from guess-and-check loops. */

const MDX_BUILD_FAILURE =
  /\b(mdx compilation failed|unexpected character|could not parse expression with acorn|micromark-extension-mdx)\b/i;

const DOCS_CONTEXT = /\b(mdx|docusaurus|livecodeblock)\b|\.mdx?\b/i;

const MODULE_RESOLUTION =
  /\b(can'?t resolve|module not found|error:\s*can'?t resolve)\b/i;

const COMPILED_WITH_PROBLEMS = /\bcompiled with problems\b/i;

/** True when the user pasted or described a Docusaurus/MDX build failure. */
export function isMdxRepairTask(text: string): boolean {
  if (MDX_BUILD_FAILURE.test(text) && DOCS_CONTEXT.test(text)) return true;
  if (COMPILED_WITH_PROBLEMS.test(text) && DOCS_CONTEXT.test(text)) return true;
  if (MDX_BUILD_FAILURE.test(text) && MODULE_RESOLUTION.test(text)) return true;
  if (/\bformik-renderer\.md\b/i.test(text) && MDX_BUILD_FAILURE.test(text)) return true;
  return false;
}

/** Extract the failing MDX path from build output when present. */
export function extractMdxErrorFile(text: string): string | undefined {
  const mdxMatch = text.match(
    /(?:MDX compilation failed for file|Error in)\s+["']([^"']+\.mdx?)["']/i
  );
  if (mdxMatch?.[1]) return mdxMatch[1];

  const webpackMatch = text.match(/\.\/docs\/[^\s:]+\.mdx?/i);
  if (webpackMatch?.[0]) return webpackMatch[0].replace(/^\.\//, '');

  const pathMatch = text.match(
    /(?:^|\s|['"`])([\w./-]+\/docs\/[\w./-]+\.mdx?)\b/i
  );
  return pathMatch?.[1];
}

/** Suggest a docs verify command from common monorepo layouts. */
export function suggestDocsVerifyCommands(): string[] {
  return [
    'cd apps/docs && npm run build',
    'npm run build --workspace docs',
    'pnpm --filter docs build',
    'npm run build',
  ];
}

/** Injected at session start for MDX/Docusaurus repair tasks in Agent mode. */
export function buildMdxRepairBootstrapBlock(errorFile?: string): string {
  const fileLine = errorFile
    ? `Target file from build output: **${errorFile}**`
    : 'Read the exact file path from the build error output first.';

  return `## MANDATORY MDX REPAIR BOOTSTRAP (first tool round)

${fileLine}

Follow this order — do NOT guess fixes without reading the file and a working sibling example:

1. **read_file** the exact failing .md file named in the build output.
2. **read_file** a sibling doc in the same folder that already uses LiveCodeBlock successfully (for example form-builder.md).
3. Fix only what the build names:
   - **Unexpected character \`,\` in name** → raw TypeScript generics in Markdown table cells. Code-span the whole cell type: \`Record<string, any>\`, \`(values: Record<string, any>) => void\`.
   - **Could not parse expression with acorn** inside LiveCodeBlock → broken JSX attribute. Use \`code={\`\` on one line, close with \`\`}\` before componentName. Never split \`code={\` and the opening backtick across lines. Do NOT put \`render(<Component />)\` inside the code string — live-demo adds render automatically.
   - **Can't resolve '@site/...' or another local component** → first run **search** for every import of the missing module and nearby sibling module names. Do NOT rename, move, or overwrite a shared component until you know all existing imports. Prefer adding the missing compatibility file or updating only the failing import. If both \`live-demo\` and \`live-demo-mui\` are referenced, keep both paths valid.
   - **Can't resolve 'pkg'** → check apps/docs/package.json for \`workspace:*\` deps, confirm packages/pkg exists, run \`pnpm install\` from the monorepo root, and build that package if dist/ is missing. This is part of the same docs build failure — do NOT dismiss it as pre-existing.
4. **run_command** the docs build (read package.json scripts first; do NOT assume \`npm run lint\` exists). Prefer \`cd apps/docs && npm run build\` or the project's documented docs build script.
5. If the build fails again, fix only the next exact file from the new build output.`;
}
