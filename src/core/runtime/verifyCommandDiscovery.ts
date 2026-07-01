import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { suggestDocsVerifyCommands } from './mdxRepairRouting';

export interface VerifyCommandPlan {
  commands: string[];
  skipped: string[];
  /** Human-readable discovery notes for the agent prompt */
  notes: string[];
  /** Suggested install commands when deps may be missing */
  installCommands: string[];
  /** package.json scripts discovered per package root (workspace-relative) */
  discoveredScripts: Record<string, string[]>;
}

export interface VerifyCommandOptions {
  touchedFiles?: string[];
  userMessage?: string;
}

const PLACEHOLDER_TEST = /no test specified|error:\s*no test|exit\s+1/i;

/** Script names to probe in priority order — only those that exist in package.json are used. */
const SCRIPT_PROBE_ORDER = [
  'typecheck',
  'build:types',
  'check:types',
  'lint',
  'check',
  'test',
  'build',
  'compile',
  'verify',
] as const;

const MODULE_RESOLUTION_ERROR =
  /\b(cannot find module|can't resolve|module not found|enoent.*node_modules|error:\s*can't resolve)\b/i;

const MISSING_BINARY =
  /\b(command not found|enoent|not recognized as an internal or external command)\b/i;

/**
 * Resolve verification commands for a task.
 * Empty `requested` → discover from project manifests and touched files (no hardcoded lint/test).
 */
export function resolveProjectVerifyCommands(
  workspace: string,
  requested: string[],
  options: VerifyCommandOptions = {}
): VerifyCommandPlan {
  const trimmed = requested.map((command) => command.trim()).filter(Boolean);
  const skipped: string[] = [];
  const commands: string[] = [];
  const notes: string[] = [];
  const installCommands: string[] = [];
  const seenTargets = new Set<string>();
  const discoveredScripts: Record<string, string[]> = {};

  const touchedFiles = options.touchedFiles ?? [];
  const docsSuggestions = suggestDocsVerifyCommands();
  const docsSuggestionRequest = trimmed.length > 0 && trimmed.every((command) => docsSuggestions.includes(command));

  if (docsSuggestionRequest) {
    addFirstResolvedCommand(workspace, docsSuggestions, commands, skipped, seenTargets);
    notes.push('Using docs build verification candidates from monorepo layout.');
    return finalizePlan(workspace, commands, skipped, notes, installCommands, discoveredScripts);
  }

  // User/settings requested explicit commands — resolve each against manifests
  for (const command of trimmed) {
    addResolvedCommand(workspace, command, commands, skipped, seenTargets);
  }

  const packageDirs = discoverPackageDirs(workspace, touchedFiles);
  for (const pkgDir of packageDirs) {
    const rel = workspaceRelative(workspace, pkgDir);
    const scripts = listAvailableScripts(pkgDir);
    if (scripts.length > 0) {
      discoveredScripts[rel] = scripts;
    }
  }

  if (packageDirs.length > 0) {
    notes.push(`Scanned ${packageDirs.length} package(s) from touched files and workspace layout.`);
  }

  // Docs touches: prefer docs build when no explicit commands matched
  const shouldPreferDocs = touchesDocs(touchedFiles) || /\b(docs?|docusaurus|mdx|preview)\b/i.test(options.userMessage ?? '');
  if (shouldPreferDocs && commands.length === 0) {
    addFirstResolvedCommand(workspace, docsSuggestions, commands, skipped, seenTargets);
    if (commands.length > 0) {
      notes.push('Docs-related changes detected — using docs build for verification.');
    }
  }

  // Dynamic discovery when nothing configured or configured scripts were all skipped
  const needsDiscovery = trimmed.length === 0 || (commands.length === 0 && skipped.length > 0);
  if (needsDiscovery) {
    const discovered = discoverVerifyCommandsForPackages(workspace, packageDirs, skipped, seenTargets, touchedFiles);
    for (const cmd of discovered) {
      if (!commands.includes(cmd)) commands.push(cmd);
    }
    if (discovered.length > 0) {
      notes.push(`Auto-discovered ${discovered.length} verify command(s) from package.json scripts.`);
    }
  }

  if (commands.length === 0) {
    const fallback = discoverManifestVerifyCommands(workspace, skipped);
    for (const cmd of fallback) {
      if (!commands.includes(cmd)) commands.push(cmd);
    }
    if (fallback.length > 0) {
      notes.push('Fell back to workspace-root manifest verification.');
    }
  }

  if (commands.length === 0 && skipped.length > 0) {
    notes.push('No runnable verify scripts found — read package.json and run the closest available check.');
  }

  const pm = packageManagerCommand(workspace);
  if (!existsSync(join(workspace, 'node_modules'))) {
    installCommands.push(`${pm} install`);
    notes.push('node_modules missing at workspace root — install dependencies before verify.');
  }

  return finalizePlan(workspace, commands, skipped, notes, installCommands, discoveredScripts);
}

/** Format discovery results for injection into agent verify prompts. */
export function formatVerifyPlanForAgent(plan: VerifyCommandPlan): string {
  const lines = [
    '## Project verification plan (discovered on the fly)',
    'Do NOT assume npm run lint or npm test exist. Use only commands listed below or read package.json first.',
  ];

  if (plan.notes.length > 0) {
    lines.push('', '### Discovery notes', ...plan.notes.map((n) => `- ${n}`));
  }

  if (Object.keys(plan.discoveredScripts).length > 0) {
    lines.push('', '### Available scripts by package');
    for (const [pkg, scripts] of Object.entries(plan.discoveredScripts)) {
      lines.push(`- **${pkg}**: ${scripts.join(', ')}`);
    }
  }

  if (plan.commands.length > 0) {
    lines.push('', '### Commands to run (in order)', ...plan.commands.map((c) => `- \`${c}\``));
  } else {
    lines.push('', '### Commands to run', '- Read package.json scripts in the touched package(s), then run the narrowest applicable check.');
  }

  if (plan.skipped.length > 0) {
    lines.push('', '### Skipped (not available in this project)', ...plan.skipped.map((s) => `- ${s}`));
  }

  if (plan.installCommands.length > 0) {
    lines.push(
      '',
      '### Dependency install (if verify fails with module resolution errors)',
      ...plan.installCommands.map((c) => `- \`${c}\` then retry the failed verify command`),
    );
  }

  lines.push(
    '',
    '### Verify policy',
    '- If a command fails with "Cannot find module" or "Can\'t resolve", run install from the monorepo root, then retry.',
    '- If a script does not exist, do not invent it — pick another available script or report the gap.',
    '- Prefer package-scoped commands (cd packages/foo && npm run build:types) over root guesses.',
  );

  return lines.join('\n');
}

/** Suggest install commands when verify output indicates missing deps. */
export function suggestInstallCommandsForVerifyFailure(
  workspace: string,
  commandOutput: string
): string[] {
  if (!MODULE_RESOLUTION_ERROR.test(commandOutput) && !MISSING_BINARY.test(commandOutput)) {
    return [];
  }
  const pm = packageManagerCommand(workspace);
  const commands = [`${pm} install`];
  if (existsSync(join(workspace, 'pnpm-workspace.yaml')) && pm === 'pnpm') {
    commands.push('pnpm install -r');
  }
  return dedupe(commands);
}

export function isModuleResolutionVerifyFailure(output: string): boolean {
  return MODULE_RESOLUTION_ERROR.test(output);
}

function finalizePlan(
  workspace: string,
  commands: string[],
  skipped: string[],
  notes: string[],
  installCommands: string[],
  discoveredScripts: Record<string, string[]>
): VerifyCommandPlan {
  void workspace;
  return {
    commands: dedupe(commands),
    skipped,
    notes,
    installCommands: dedupe(installCommands),
    discoveredScripts,
  };
}

function discoverPackageDirs(workspace: string, touchedFiles: string[]): string[] {
  const dirs = new Set<string>();
  const root = resolve(workspace);

  for (const file of touchedFiles) {
    let dir = resolve(root, dirname(file));
    while (dir.startsWith(root)) {
      if (existsSync(join(dir, 'package.json'))) {
        dirs.add(dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  if (dirs.size === 0 && existsSync(join(root, 'package.json'))) {
    dirs.add(root);
  }

  // Include apps/docs when docs paths touched but package not found walking up
  for (const file of touchedFiles) {
    const match = file.match(/^(apps\/docs|docs)\//);
    if (match) {
      const docsPkg = join(root, match[1] === 'docs' ? 'docs' : 'apps/docs');
      if (existsSync(join(docsPkg, 'package.json'))) dirs.add(docsPkg);
    }
  }

  return [...dirs];
}

function listAvailableScripts(pkgDir: string): string[] {
  const pkg = readPackageJson(pkgDir);
  if (!pkg?.scripts) return [];
  return Object.keys(pkg.scripts).filter((name) => {
    if (name === 'test' && PLACEHOLDER_TEST.test(pkg.scripts![name] ?? '')) return false;
    return true;
  });
}

function discoverVerifyCommandsForPackages(
  workspace: string,
  packageDirs: string[],
  skipped: string[],
  seenTargets: Set<string>,
  touchedFiles: string[] = []
): string[] {
  const commands: string[] = [];
  const dirs = packageDirs.length > 0 ? packageDirs : [workspace];

  for (const pkgDir of dirs) {
    const pkg = readPackageJson(pkgDir);
    if (!pkg?.scripts) continue;

    const rel = workspaceRelative(workspace, pkgDir);
    const pm = packageManagerCommand(pkgDir);
    const relPrefix = rel && rel !== '.' ? `cd ${rel} && ` : '';

    for (const script of probeOrderForPackage(pkgDir, rel, touchedFiles)) {
      if (!(script in pkg.scripts)) continue;
      const cmd = script === 'test'
        ? `${relPrefix}${pm} test`
        : `${relPrefix}${pm} run ${script}`;
      if (addResolvedCommand(workspace, cmd, commands, skipped, seenTargets)) {
        break;
      }
    }
  }

  return commands;
}

function workspaceRelative(workspace: string, absDir: string): string {
  const rel = relative(resolve(workspace), resolve(absDir)).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

function probeOrderForPackage(pkgDir: string, rel: string, touchedFiles: string[]): readonly string[] {
  const pkg = readPackageJson(pkgDir);
  const scripts = pkg?.scripts ?? {};
  const isDocs =
    /docs|docusaurus/i.test(rel) ||
    touchesDocs(touchedFiles.filter((f) => f.startsWith(rel.replace(/^\.\/?/, ''))));
  if (isDocs && 'build' in scripts) {
    return ['build', 'typecheck', 'build:types', 'lint', 'check', 'test', 'compile', 'verify'];
  }
  return SCRIPT_PROBE_ORDER;
}

function addResolvedCommand(
  workspace: string,
  command: string,
  commands: string[],
  skipped: string[],
  seenTargets: Set<string>
): boolean {
  const resolved = resolveRequestedCommand(workspace, command);
  if (resolved.run) {
    if (resolved.targetKey) {
      if (seenTargets.has(resolved.targetKey)) return false;
      seenTargets.add(resolved.targetKey);
    }
    commands.push(command);
    return true;
  } else if (resolved.reason) {
    skipped.push(`${command}: ${resolved.reason}`);
  }
  return false;
}

function addFirstResolvedCommand(
  workspace: string,
  requested: string[],
  commands: string[],
  skipped: string[],
  seenTargets: Set<string>
): void {
  for (const command of requested) {
    if (addResolvedCommand(workspace, command, commands, skipped, seenTargets)) return;
  }
}

function resolveRequestedCommand(workspace: string, command: string): { run: boolean; reason?: string; targetKey?: string } {
  const parsed = parseCdPrefix(workspace, command);
  const cwd = parsed.cwd;
  const cmd = parsed.command;

  const npmWorkspace = cmd.match(/^npm\s+run\s+([\w:-]+)\s+--workspace(?:=|\s+)([\w@/.-]+)\b/i);
  if (npmWorkspace) {
    const [, script, workspaceSpec] = npmWorkspace;
    const pkgDir = findWorkspacePackageDir(workspace, workspaceSpec);
    if (!pkgDir) return { run: false, reason: `workspace ${workspaceSpec} not found` };
    return packageScriptDecision(pkgDir, script);
  }

  const pnpmFilter = cmd.match(/^pnpm\s+--filter\s+([\w@/.-]+)\s+([\w:-]+)\b/i);
  if (pnpmFilter) {
    const [, workspaceSpec, script] = pnpmFilter;
    const pkgDir = findWorkspacePackageDir(workspace, workspaceSpec);
    if (!pkgDir) return { run: false, reason: `workspace ${workspaceSpec} not found` };
    return packageScriptDecision(pkgDir, script);
  }

  const npmRun = cmd.match(/^npm\s+run\s+([\w:-]+)\b/i);
  if (npmRun) return packageScriptDecision(cwd, npmRun[1]);
  if (/^npm\s+(test|t)\b/i.test(cmd)) return packageScriptDecision(cwd, 'test');

  const pnpmRun = cmd.match(/^pnpm\s+(?:run\s+)?([\w:-]+)\b/i);
  if (pnpmRun && !['why', 'list', 'install'].includes(pnpmRun[1])) {
    return packageScriptDecision(cwd, pnpmRun[1]);
  }

  const yarnRun = cmd.match(/^yarn\s+(?:run\s+)?([\w:-]+)\b/i);
  if (yarnRun && !['why', 'list', 'info'].includes(yarnRun[1])) {
    return packageScriptDecision(cwd, yarnRun[1]);
  }

  if (/^(?:\.\/mvnw|mvn)\s+test\b/i.test(cmd)) {
    return existsSync(join(cwd, 'pom.xml'))
      ? { run: true, targetKey: `${cwd}:maven:test` }
      : { run: false, reason: 'pom.xml not found' };
  }

  if (/^(?:\.\/gradlew|gradle)\s+test\b/i.test(cmd)) {
    return existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))
      ? { run: true, targetKey: `${cwd}:gradle:test` }
      : { run: false, reason: 'Gradle build file not found' };
  }

  if (/^cargo\s+test\b/i.test(cmd)) {
    return existsSync(join(cwd, 'Cargo.toml'))
      ? { run: true, targetKey: `${cwd}:cargo:test` }
      : { run: false, reason: 'Cargo.toml not found' };
  }

  if (/^go\s+test\b/i.test(cmd)) {
    return existsSync(join(cwd, 'go.mod')) && hasMatchingFile(cwd, /_test\.go$/)
      ? { run: true, targetKey: `${cwd}:go:test` }
      : { run: false, reason: 'go.mod or Go test files not found' };
  }

  if (/^(?:python(?:3)?\s+-m\s+pytest|pytest)\b/i.test(cmd)) {
    return hasPythonTestSignal(cwd)
      ? { run: true, targetKey: `${cwd}:python:pytest` }
      : { run: false, reason: 'Python test config/files not found' };
  }

  return { run: true };
}

function discoverManifestVerifyCommands(workspace: string, skipped: string[]): string[] {
  const commands: string[] = [];
  const pkg = readPackageJson(workspace);
  if (pkg) {
    const packageRunner = packageManagerCommand(workspace);
    for (const script of SCRIPT_PROBE_ORDER) {
      const decision = packageScriptDecision(workspace, script);
      if (decision.run) {
        commands.push(script === 'test' ? `${packageRunner} test` : `${packageRunner} run ${script}`);
      } else if (decision.reason && (script === 'lint' || script === 'test')) {
        skipped.push(`${packageRunner} ${script === 'test' ? 'test' : `run ${script}`}: ${decision.reason}`);
      }
    }
    return commands;
  }

  if (existsSync(join(workspace, 'pom.xml'))) {
    commands.push(existsSync(join(workspace, 'mvnw')) ? './mvnw test' : 'mvn test');
  } else if (existsSync(join(workspace, 'build.gradle')) || existsSync(join(workspace, 'build.gradle.kts'))) {
    commands.push(existsSync(join(workspace, 'gradlew')) ? './gradlew test' : 'gradle test');
  } else if (existsSync(join(workspace, 'Cargo.toml'))) {
    commands.push('cargo test');
  } else if (existsSync(join(workspace, 'go.mod')) && hasMatchingFile(workspace, /_test\.go$/)) {
    commands.push('go test ./...');
  } else if (hasPythonTestSignal(workspace)) {
    commands.push('python -m pytest');
  }

  return commands;
}

function packageScriptDecision(dir: string, script: string): { run: boolean; reason?: string; targetKey?: string } {
  const pkg = readPackageJson(dir);
  if (!pkg) return { run: false, reason: 'package.json not found' };
  const command = pkg.scripts?.[script];
  if (!command) return { run: false, reason: `script "${script}" not found in package.json` };
  if (script === 'test' && PLACEHOLDER_TEST.test(command)) {
    return { run: false, reason: 'package.json test script is a placeholder' };
  }
  return { run: true, targetKey: `${dir}:package-script:${script}` };
}

function readPackageJson(dir: string): { name?: string; scripts?: Record<string, string> } | null {
  try {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; scripts?: Record<string, string> };
  } catch {
    return null;
  }
}

function parseCdPrefix(workspace: string, command: string): { cwd: string; command: string } {
  const match = command.match(/^cd\s+([^&;]+)\s*&&\s*([\s\S]+)$/);
  if (!match) return { cwd: workspace, command };
  const rawDir = match[1].trim().replace(/^['"]|['"]$/g, '');
  const cwd = resolve(workspace, rawDir);
  return cwd.startsWith(resolve(workspace)) ? { cwd, command: match[2].trim() } : { cwd: workspace, command: match[2].trim() };
}

function findWorkspacePackageDir(workspace: string, spec: string): string | null {
  const direct = resolve(workspace, spec);
  if (direct.startsWith(resolve(workspace)) && readPackageJson(direct)) return direct;

  const queue = [workspace];
  let visited = 0;
  while (queue.length > 0 && visited < 500) {
    const dir = queue.shift()!;
    visited += 1;
    const pkg = readPackageJson(dir);
    if (pkg?.name === spec || basename(dir) === spec) return dir;
    for (const child of safeReadDirs(dir)) {
      if (['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.mitii'].includes(basename(child))) continue;
      queue.push(child);
    }
  }
  return null;
}

function safeReadDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((entry) => join(dir, entry))
      .filter((entry) => {
        try {
          return statSync(entry).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function hasPythonTestSignal(workspace: string): boolean {
  const hasConfig = ['pytest.ini', 'tox.ini', 'pyproject.toml', 'setup.cfg'].some((file) => existsSync(join(workspace, file)));
  return hasConfig && hasMatchingFile(workspace, /(?:^|\/)(?:test_.+|.+_test)\.py$/);
}

function hasMatchingFile(root: string, pattern: RegExp): boolean {
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 1000) {
    const dir = queue.shift()!;
    visited += 1;
    for (const entry of safeReadEntries(dir)) {
      const name = basename(entry);
      if (['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.mitii', 'target'].includes(name)) continue;
      try {
        const stat = statSync(entry);
        if (stat.isDirectory()) queue.push(entry);
        else if (pattern.test(entry.replace(/\\/g, '/'))) return true;
      } catch {
        // Ignore broken links/permission errors.
      }
    }
  }
  return false;
}

function safeReadEntries(dir: string): string[] {
  try {
    return readdirSync(dir).map((entry) => join(dir, entry));
  } catch {
    return [];
  }
}

function packageManagerCommand(workspace: string): 'npm' | 'pnpm' | 'yarn' {
  if (existsSync(join(workspace, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(workspace, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function touchesDocs(files: string[]): boolean {
  return files.some((file) =>
    /(?:^|\/)(?:apps\/docs|docs)\/.+\.(?:mdx?|tsx?|jsx?)$/i.test(file) ||
    /\.(?:mdx?)$/i.test(file)
  );
}
