const DOCS_INTENT =
  /\b(docs?|documentation|docusaurus|mdx?|sidebar|navbar|routeBasePath|docsPluginId|installation|configuration|examples?)\b/i;

const BROAD_FEATURE_SCOPE =
  /\b(all|every|features?|components?|exports?|api|fields?|types?)\b/i;

const PACKAGE_LIKE_NAME = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi;

const DOCS_CONTEXT_HINTS = [
  'apps/docs/docusaurus.config.ts',
  'apps/docs/sidebars.ts',
  'apps/docs/sidebars.js',
  'apps/docs/sidebarsCore.ts',
  'apps/docs/sidebarsFormBuilder.ts',
  'apps/docs/sidebarsFfbMui.ts',
  'apps/docs/docs/core/index.md',
  'apps/docs/docs/form-builder/index.md',
  'apps/docs/docs/ffb-mui/index.md',
  'docusaurus.config.ts',
  'sidebars.ts',
  'sidebars.js',
  'sidebarsFfbMui.ts',
  'package.json',
  'src/index.ts',
  'src/types/index.ts',
  'src/fields/index.ts',
  'exports',
  'docs plugin',
  'navbar',
  'routeBasePath',
  'sidebarPath',
  'docsPluginId',
  'installation',
  'configuration',
  'examples',
].join(' ');

export function expandContextQuery(userMessage: string): string {
  if (!DOCS_INTENT.test(userMessage) && !/\badd\b[\s\S]{0,80}\bfeatures?\b/i.test(userMessage)) {
    return userMessage;
  }

  const packageHints = extractPackageHints(userMessage);
  const scopeHints = BROAD_FEATURE_SCOPE.test(userMessage)
    ? 'all features all components all exports public API field types examples'
    : '';

  return [userMessage, DOCS_CONTEXT_HINTS, packageHints, scopeHints]
    .filter(Boolean)
    .join('\n\nContext retrieval hints: ');
}

function extractPackageHints(text: string): string {
  const names = [...new Set(text.match(PACKAGE_LIKE_NAME) ?? [])]
    .filter((name) => !['route-base', 'docs-plugin'].includes(name.toLowerCase()))
    .slice(0, 5);

  return names
    .flatMap((name) => [
      `packages/${name}/package.json`,
      `packages/${name}/src/index.ts`,
      `packages/${name}/src/types/index.ts`,
      `packages/${name}/src/fields/index.ts`,
      `packages/${name}/src/fields`,
      `apps/docs/docs/${name}/index.md`,
    ])
    .join(' ');
}
