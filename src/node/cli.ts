#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { AuditPackBuilder } from '../core/audit';
import { generateHeadlessChangelog, prepareHeadlessRelease } from '../core/headless';

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const cwd = resolve(valueOf(args, '--cwd') ?? process.cwd());
  const since = valueOf(args, '--since');
  const json = args.includes('--json');

  if (!command || command === '--help' || command === 'help') {
    printHelp();
    return 0;
  }

  if (command === 'changelog') {
    const changelog = await generateHeadlessChangelog(cwd, since);
    process.stdout.write(json ? JSON.stringify({ changelog }, null, 2) + '\n' : changelog);
    return 0;
  }

  if (command === 'prepare-release') {
    const result = await prepareHeadlessRelease(cwd, since);
    process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : result.releaseNotes);
    return 0;
  }

  if (command === 'export-audit') {
    const session = valueOf(args, '--session');
    const output = valueOf(args, '--output') ?? join(cwd, `.mitii/audit/mitii-audit-${Date.now()}.zip`);
    const logPath = session && existsSync(session) ? session : latestSessionLog(cwd);
    const pack = new AuditPackBuilder().build({
      sessionId: session ?? 'headless',
      workspace: cwd,
      extensionVersion: readPackageVersion(cwd),
      logPath,
      summaryMarkdown: logPath ? `# Mitii audit export\n\nLog: ${logPath}\n` : '# Mitii audit export\n\nNo session log found.\n',
    });
    writeFileSync(output, pack.buffer);
    process.stdout.write(json ? JSON.stringify({ output, entries: pack.entries }, null, 2) + '\n' : `${output}\n`);
    return 0;
  }

  if (command === 'ask' || command === 'agent' || command === 'commit-msg') {
    process.stderr.write(`${command} requires the VS Code extension runtime in this MVP. Use changelog, prepare-release, or export-audit headlessly.\n`);
    return 2;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  return 1;
}

function valueOf(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function latestSessionLog(cwd: string): string | undefined {
  const dir = join(cwd, '.mitii', 'logs');
  if (!existsSync(dir)) return undefined;
  const fs = require('fs') as typeof import('fs');
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
  const last = files[files.length - 1];
  return last ? join(dir, last) : undefined;
}

function readPackageVersion(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  process.stdout.write([
    'Mitii CLI',
    '',
    'Commands:',
    '  mitii changelog [--since <tag>] [--cwd <path>] [--json]',
    '  mitii prepare-release [--since <tag>] [--cwd <path>] [--json]',
    '  mitii export-audit [--session <jsonl-path>] [--output <zip>] [--cwd <path>] [--json]',
    '',
  ].join('\n'));
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

