/**
 * Lightweight PageRank over a directed graph (file → referenced file).
 * Returns scores keyed by node id.
 */
export function computePageRank(
  nodes: string[],
  edges: Array<{ from: string; to: string; weight?: number }>,
  options: { damping?: number; iterations?: number } = {}
): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 20;
  const nodeSet = new Set(nodes);
  const scores = new Map<string, number>();
  const outLinks = new Map<string, Array<{ to: string; weight: number }>>();

  for (const node of nodes) {
    scores.set(node, 1 / Math.max(nodes.length, 1));
    outLinks.set(node, []);
  }

  for (const edge of edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    outLinks.get(edge.from)!.push({ to: edge.to, weight: edge.weight ?? 1 });
  }

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    const base = (1 - damping) / Math.max(nodes.length, 1);

    for (const node of nodes) {
      next.set(node, base);
    }

    for (const node of nodes) {
      const links = outLinks.get(node) ?? [];
      if (links.length === 0) {
        const share = (scores.get(node) ?? 0) * damping / Math.max(nodes.length, 1);
        for (const n of nodes) {
          next.set(n, (next.get(n) ?? 0) + share);
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
