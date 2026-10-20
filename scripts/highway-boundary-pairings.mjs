// Experimental transition state for the outer-boundary search. These pairings
// preserve source-road continuity; they are not a planar face rotation.
export function boundaryPairingChoices(incident, legal) {
  const choices = [];
  function visit(remaining, pairs) {
    if (!remaining.length) {
      choices.push(pairs);
      return;
    }
    const [first, ...rest] = remaining;
    visit(rest, pairs);
    for (let j = 0; j < rest.length; j++) {
      const other = rest[j];
      if (legal(first, other))
        visit(
          rest.filter((_, k) => k !== j),
          [...pairs, [first, other]],
        );
    }
  }
  visit(
    [...incident].sort((a, b) => a - b),
    [],
  );
  return choices;
}

export function pairedBoundaryWalks(graph, pairings) {
  const successor = new Map();
  for (const [vertex, pairs] of pairings) {
    const used = new Set();
    for (const [a, b] of pairs) {
      if (used.has(a) || used.has(b) || !graph.legal(a, b, vertex))
        throw new Error('Invalid or overlapping boundary pairing');
      used.add(a);
      used.add(b);
      for (const [incoming, outgoing] of [
        [a, b],
        [b, a],
      ]) {
        const from = graph.edges[incoming],
          to = graph.edges[outgoing];
        if (
          ![from.fromId, from.toId].includes(vertex) ||
          ![to.fromId, to.toId].includes(vertex)
        )
          throw new Error('Pairing does not meet at vertex');
        successor.set(
          2 * incoming + (from.fromId === vertex ? 1 : 0),
          2 * outgoing + (to.fromId === vertex ? 0 : 1),
        );
      }
    }
  }
  const seen = new Set(),
    cycles = [];
  for (const start of successor.keys()) {
    if (seen.has(start)) continue;
    const cycle = [];
    let h = start;
    while (h !== undefined && !seen.has(h)) {
      seen.add(h);
      cycle.push(h);
      h = successor.get(h);
    }
    if (h === start) cycles.push(cycle);
  }
  return cycles;
}
