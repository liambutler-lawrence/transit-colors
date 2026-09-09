import type { Point } from './routing/types.js';

interface SegmentNode {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly first: number;
  readonly last: number;
  readonly children: readonly SegmentNode[];
}

function boundsDistanceSquared(point: Point, node: SegmentNode): number {
  return (
    Math.max(node.west - point.x, 0, point.x - node.east) ** 2 +
    Math.max(node.south - point.y, 0, point.y - node.north) ** 2
  );
}

function segmentDistanceSquared(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
          ),
        );
  return (
    (point.x - start.x - dx * fraction) ** 2 + (point.y - start.y - dy * fraction) ** 2
  );
}

/** Index contiguous pieces of a route without simplifying away its bends. */
export class RouteDistanceIndex {
  private readonly root: SegmentNode;

  constructor(private readonly points: readonly Point[]) {
    const build = (first: number, last: number): SegmentNode => {
      const children: SegmentNode[] = [];
      if (last - first > 8) {
        const middle = Math.floor((first + last) / 2);
        children.push(build(first, middle), build(middle, last));
      }
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      if (children.length) {
        for (const child of children) {
          west = Math.min(west, child.west);
          south = Math.min(south, child.south);
          east = Math.max(east, child.east);
          north = Math.max(north, child.north);
        }
      } else {
        for (let index = first; index <= last; index += 1) {
          const point = points[index];
          if (!point) continue;
          west = Math.min(west, point.x);
          south = Math.min(south, point.y);
          east = Math.max(east, point.x);
          north = Math.max(north, point.y);
        }
      }
      return { west, south, east, north, first, last, children };
    };
    this.root = build(0, points.length - 1);
  }

  distance(point: Point, maximum: number): number {
    let best = maximum * maximum;
    const visit = (node: SegmentNode): void => {
      if (boundsDistanceSquared(point, node) >= best) return;
      const [left, right] = node.children;
      if (left && right) {
        if (boundsDistanceSquared(point, left) < boundsDistanceSquared(point, right)) {
          visit(left);
          visit(right);
        } else {
          visit(right);
          visit(left);
        }
        return;
      }
      for (let index = node.first; index < node.last; index += 1) {
        const start = this.points[index];
        const end = this.points[index + 1];
        if (start && end) {
          best = Math.min(best, segmentDistanceSquared(point, start, end));
        }
      }
    };
    visit(this.root);
    return Math.sqrt(best);
  }
}
