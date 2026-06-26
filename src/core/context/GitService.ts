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
}
