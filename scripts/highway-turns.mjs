// Ports describe travel AWAY from a junction in the ordering of its paired
// mainline. A ramp's port follows its source carriageway, not the shape of
// the averaged ramp: a loop or a staggered join can point the other way.
export function highwayTurnPort(edge, nodeId) {
  if (edge.fromId === nodeId) return edge.fromTurnPort;
  if (edge.toId === nodeId) return edge.toTurnPort;
  return undefined;
}

export function highwayTurnAllowed(first, second, nodeId) {
  if (first === second || first.invalidTurn || second.invalidTurn) return false;
  const a = highwayTurnPort(first, nodeId);
  const b = highwayTurnPort(second, nodeId);
  if (!a || !b) return !a && !b;
  if (a.mainlineId !== b.mainlineId) return false;
  return a.direction !== 0 && b.direction !== 0 && a.direction === -b.direction;
}

export function highwayEdgeUsable(edge) {
  return (
    !edge.invalidTurn &&
    edge.fromId !== edge.toId &&
    (!edge.fromTurnPort || [-1, 1].includes(edge.fromTurnPort.direction)) &&
    (!edge.toTurnPort || [-1, 1].includes(edge.toTurnPort.direction))
  );
}

export function highwayCycleTurnViolation(steps, edges) {
  for (let index = 0; index < steps.length; index += 1) {
    const next = (index + 1) % steps.length;
    if (
      !highwayTurnAllowed(
        edges[steps[index].edgeIndex],
        edges[steps[next].edgeIndex],
        steps[index].toId,
      )
    )
      return [index, next];
  }
  return null;
}
