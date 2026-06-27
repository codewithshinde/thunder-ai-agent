export interface PageRankOptions {
  damping?: number;
  iterations?: number;
  /** Personalization vector — boosts restart probability for key nodes (e.g. open files). */
  personalization?: Map<string, number>;
}

/**
 * PageRank over a directed graph (file → referenced file).
 * Supports weighted edges and optional personalization (Aider-style context boosts).
 */
export function computePageRank(
  nodes: string[],
  edges: Array<{ from: string; to: string; weight?: number }>,
  options: PageRankOptions = {}
): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;
  const nodeSet = new Set(nodes);
  const scores = new Map<string, number>();
  const outLinks = new Map<string, Array<{ to: string; weight: number }>>();

  const personalization = normalizePersonalization(nodes, options.personalization);

  for (const node of nodes) {
    scores.set(node, 1 / Math.max(nodes.length, 1));
    outLinks.set(node, []);
  }

  // Aggregate parallel edges between same pair
  const edgeWeights = new Map<string, number>();
  for (const edge of edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to) || edge.from === edge.to) continue;
    const key = `${edge.from}\0${edge.to}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + (edge.weight ?? 1));
  }

  for (const [key, weight] of edgeWeights) {
    const [from, to] = key.split('\0');
    outLinks.get(from)!.push({ to, weight });
  }

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();

    for (const node of nodes) {
      next.set(node, (1 - damping) * (personalization.get(node) ?? 0));
    }

    for (const node of nodes) {
      const links = outLinks.get(node) ?? [];
      if (links.length === 0) {
        const share = (scores.get(node) ?? 0) * damping;
        for (const n of nodes) {
          next.set(n, (next.get(n) ?? 0) + share * (personalization.get(n) ?? 0));
        }
        continue;
      }

      const totalWeight = links.reduce((s, l) => s + l.weight, 0);
      const share = ((scores.get(node) ?? 0) * damping) / totalWeight;
      for (const link of links) {
        next.set(link.to, (next.get(link.to) ?? 0) + share * link.weight);
      }
    }

    for (const node of nodes) {
      scores.set(node, next.get(node) ?? 0);
    }
  }

  return scores;
}

function normalizePersonalization(
  nodes: string[],
  personalization?: Map<string, number>
): Map<string, number> {
  const result = new Map<string, number>();
  if (!personalization || personalization.size === 0) {
    const uniform = 1 / Math.max(nodes.length, 1);
    for (const node of nodes) result.set(node, uniform);
    return result;
  }

  let total = 0;
  for (const node of nodes) {
    const weight = personalization.get(node) ?? 0;
    total += weight;
  }

  if (total <= 0) {
    const uniform = 1 / Math.max(nodes.length, 1);
    for (const node of nodes) result.set(node, uniform);
    return result;
  }

  for (const node of nodes) {
    result.set(node, (personalization.get(node) ?? 0) / total);
  }
  return result;
}
