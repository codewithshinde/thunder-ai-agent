import type { DiagnosticsService } from '../context/DiagnosticsService';

export interface ValidationError {
  line: number;
  message: string;
}

export interface PostEditValidationResult {
  relPath: string;
  errors: ValidationError[];
  lintOutput?: string;
}

/**
 * Aider-style post-edit reflection — wait for VS Code diagnostics after a write.
 */
export class PostEditValidator {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  async validate(relPath: string): Promise<PostEditValidationResult> {
    const errors = await this.diagnostics.waitForFileErrors(relPath);
    return { relPath, errors };
  }

  formatForAgent(result: PostEditValidationResult): string {
    if (result.errors.length === 0) {
      return `Validated ${result.relPath}: no linter/type errors detected.`;
    }
    const lines = result.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
    return `Validation errors in ${result.relPath} after edit:\n${lines}\nFix these errors before continuing.`;
  }
}
