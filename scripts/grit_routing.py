"""Deterministic main-stem routing; never join whole canal-connected components."""
import math


def route_segments(rows):
    segments = {r['global_id']: r for r in rows}
    assert len(segments) == len(rows)
    outgoing = {}
    def priority(r):
        width = r['width_adjusted']
        return (r['is_mainstem'], width if width is not None and math.isfinite(width) else 0, -r['global_id'])
    for r in rows:
        node = r['upstream_node_id']
        if node not in outgoing or priority(r) > priority(segments[outgoing[node]]):
            outgoing[node] = r['global_id']
    resolved = {}
    for identifier in segments:
        path, seen = [], set()
        current = identifier
        while current not in resolved:
            if current in seen:
                raise ValueError(f'Unresolved routing cycle at segment {current}')
            seen.add(current)
            path.append(current)
            r = segments[current]
            downstream = outgoing.get(r['downstream_node_id'])
            if downstream is None:
                resolved[current] = (r['downstream_node_id'], current)
                break
            current = downstream
        for item in path:
            resolved[item] = resolved[current]
    return resolved
