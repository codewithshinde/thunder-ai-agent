import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { suggestDocsVerifyCommands } from './mdxRepairRouting';

export interface VerifyCommandPlan {
  commands: string[];
  skipped: string[];
}

export interface VerifyCommandOptions {
  touchedFiles?: string[];
}

const DEFAULT_VERIFY_COMMANDS = new Set(['npm run lint', 'npm test']);
const PLACEHOLDER_TEST = /no test specified|error:\s*no test|exit\s+1/i;

export function resolveProjectVerifyCommands(
  workspace: string,
  requested: string[],
  options: VerifyCommandOptions = {}
): VerifyCommandPlan {
  const trimmed = requested.map((command) => command.trim()).filter(Boolean);
  const skipped: string[] = [];
  const commands: string[] = [];
  const seenTargets = new Set<string>();
  const docsSuggestions = suggestDocsVerifyCommands();
  const docsSuggestionRequest = trimmed.length > 0 && trimmed.every((command) => docsSuggestions.includes(command));

  if (docsSuggestionRequest) {
    addFirstResolvedCommand(workspace, docsSuggestions, commands, skipped, seenTargets);
    return {
      commands: dedupe(commands),
      skipped,
    };
  }

  for (const command of trimmed) {
    addResolvedCommand(workspace, command, commands, skipped, seenTargets);
  }

  const defaultOnly = trimmed.length === 0 || trimmed.every((command) => DEFAULT_VERIFY_COMMANDS.has(command));
  if (defaultOnly && touchesDocs(options.touchedFiles ?? [])) {
    addFirstResolvedCommand(workspace, docsSuggestions, commands, skipped, seenTargets);
  }

  if (commands.length === 0 && defaultOnly) {
    commands.push(...discoverManifestVerifyCommands(workspace, skipped));
  }

  return {
    commands: dedupe(commands),
    skipped,
  };
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
    for (const script of ['lint', 'typecheck', 'test', 'check']) {
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
