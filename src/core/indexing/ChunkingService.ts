export interface FileChunk {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  tokenEstimate: number;
  hash: string;
}

const FALLBACK_CHUNK_LINES = 100;

export class ChunkingService {
  chunkFile(content: string, language: string | null): FileChunk[] {
    const lines = content.split('\n');
    const boundaries = this.findBoundaries(lines, language);

    if (boundaries.length === 0) {
      return this.fallbackChunk(lines);
    }

    const chunks: FileChunk[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : lines.length;
      const chunkLines = lines.slice(start - 1, end);
      const chunkContent = chunkLines.join('\n');
      chunks.push({
        chunkIndex: i,
        startLine: start,
        endLine: end,
        content: chunkContent,
        tokenEstimate: Math.ceil(chunkContent.length / 4),
        hash: simpleHash(chunkContent),
      });
    }
    return chunks;
  }

  private findBoundaries(lines: string[], language: string | null): number[] {
    const patterns: RegExp[] = [];
    switch (language) {
      case 'typescript':
      case 'javascript':
        patterns.push(
          /^(export\s+)?(async\s+)?function\s+\w+/,
          /^(export\s+)?class\s+\w+/,
          /^(export\s+)?interface\s+\w+/,
          /^(export\s+)?type\s+\w+/,
          /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
        );
        break;
      case 'python':
        patterns.push(/^class\s+\w+/, /^def\s+\w+/, /^async\s+def\s+\w+/);
        break;
      case 'java':
        patterns.push(/^(public|private|protected)?\s*(static\s+)?class\s+\w+/, /^\s+(public|private|protected)?\s+\w+.*\(/);
        break;
      case 'go':
        patterns.push(/^func\s+/, /^type\s+\w+/, /^interface\s*\{/);
        break;
      default:
        return [];
    }

    const boundaries: number[] = [1];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (patterns.some((p) => p.test(line))) {
        if (boundaries[boundaries.length - 1] !== i + 1) {
          boundaries.push(i + 1);
        }
      }
    }
    return boundaries.length > 1 ? boundaries : [];
  }

  private fallbackChunk(lines: string[]): FileChunk[] {
    const chunks: FileChunk[] = [];
    for (let i = 0; i < lines.length; i += FALLBACK_CHUNK_LINES) {
      const chunkLines = lines.slice(i, i + FALLBACK_CHUNK_LINES);
      const content = chunkLines.join('\n');
      chunks.push({
        chunkIndex: chunks.length,
        startLine: i + 1,
        endLine: Math.min(i + FALLBACK_CHUNK_LINES, lines.length),
        content,
        tokenEstimate: Math.ceil(content.length / 4),
        hash: simpleHash(content),
      });
    }
    return chunks;
  }
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}
