import * as vscode from 'vscode';

export interface UserSafeError {
  message: string;
  code?: string;
  debugDetails?: string;
}

export function isDebugMode(): boolean {
  return vscode.workspace.getConfiguration('thunder').get<boolean>('debug', false);
}

export function normalizeError(error: unknown): UserSafeError {
  if (error instanceof Error) {
    return {
      message: error.message || 'An unexpected error occurred',
      code: error.name,
      debugDetails: isDebugMode() ? error.stack : undefined,
    };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  return { message: 'An unexpected error occurred' };
}

export function formatUserError(error: UserSafeError): string {
  if (isDebugMode() && error.debugDetails) {
    return `${error.message}\n\n${error.debugDetails}`;
  }
  return error.message;
}
