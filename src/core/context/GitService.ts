import simpleGit, { type SimpleGit } from 'simple-git';
import { createLogger } from '../telemetry/Logger';

const log = createLogger('GitService');

export class GitService {
  private git: SimpleGit | undefined;
  private isRepo = false;

  constructor(private readonly workspacePath: string) {}

  async initialize(): Promise<void> {
    if (!this.workspacePath) return;
    try {
      this.git = simpleGit(this.workspacePath);
      this.isRepo = await this.git.checkIsRepo();
    } catch {
      this.isRepo = false;
      log.info('Not a git repository');
    }
  }

  async getCurrentBranch(): Promise<string | null> {
    if (!this.isRepo || !this.git) return null;
    try {
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch {
      return null;
    }
  }

  async getChangedFiles(): Promise<string[]> {
    if (!this.isRepo || !this.git) return [];
    try {
      const status = await this.git.status();
      return [...status.modified, ...status.created, ...status.deleted, ...status.renamed.map((r) => r.to)];
    } catch {
      return [];
    }
  }

  async getDiff(maxChars = 8000): Promise<string> {
    if (!this.isRepo || !this.git) return '';
    try {
      const diff = await this.git.diff();
      return diff.slice(0, maxChars);
    } catch {
      return '';
    }
  }

  async getStagedDiff(maxChars = 16_000): Promise<string> {
    if (!this.isRepo || !this.git) return '';
    try {
      const diff = await this.git.diff(['--cached']);
      return diff.slice(0, maxChars);
    } catch {
      return '';
    }
  }

  async getUnstagedDiff(maxChars = 12_000): Promise<string> {
    if (!this.isRepo || !this.git) return '';
    try {
      const diff = await this.git.diff();
      return diff.slice(0, maxChars);
    } catch {
      return '';
    }
  }

  async getRecentCommits(limit = 5): Promise<string[]> {
    if (!this.isRepo || !this.git) return [];
    try {
      const output = await this.git.raw(['log', `-${Math.max(1, Math.min(limit, 20))}`, '--oneline']);
      return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async getChangedFilesDetailed(): Promise<string[]> {
    if (!this.isRepo || !this.git) return [];
    try {
      const output = await this.git.raw(['diff', '--name-status', 'HEAD']);
      return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      return this.getChangedFiles();
    }
  }

  get isGitRepo(): boolean {
    return this.isRepo;
  }

  async stashFiles(message: string, files: string[]): Promise<string | null> {
    if (!this.isRepo || !this.git || files.length === 0) return null;
    try {
      await this.git.stash(['push', '-m', message, '--', ...files]);
      const list = String(await this.git.stashList());
      const lines = list.split('\n').filter(Boolean);
      const match = lines.find((line) => line.includes(message));
      if (match) {
        const ref = match.split(':')[0]?.trim();
        return ref ?? `stash@{0}`;
      }
      return lines[0]?.split(':')[0]?.trim() ?? 'stash@{0}';
    } catch (error) {
      log.warn('Git stash checkpoint failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async restoreFromStash(stashRef: string, files: string[]): Promise<boolean> {
    if (!this.isRepo || !this.git) return false;
    try {
      if (files.length > 0) {
        await this.git.checkout([stashRef, '--', ...files]);
      } else {
        await this.git.stash(['apply', stashRef]);
      }
      return true;
    } catch (error) {
      log.warn('Git stash restore failed', {
        error: error instanceof Error ? error.message : String(error),
        stashRef,
      });
      return false;
    }
  }
}
