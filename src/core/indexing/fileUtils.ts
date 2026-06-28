import { detectLanguageFromPath } from './languageRegistry';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.sqlite', '.db', '.wasm',
]);

export function isBinaryByExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Detect language from file path using the 100+ extension registry. */
export function detectLanguage(filePath: string): string | null {
  return detectLanguageFromPath(filePath);
}
