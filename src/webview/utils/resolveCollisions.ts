import type { Node } from '@xyflow/react';

interface ResolveCollisionsOptions {
  maxIterations?: number;
  overlapThreshold?: number;
  margin?: number;
}

interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
}

/**
 * Resolves node collisions by moving overlapping nodes apart.
 * Based on React Flow's node collision example.
 */
export function resolveCollisions(
  nodes: Node[],
  options: ResolveCollisionsOptions = {}
): Node[] {
  const { maxIterations = 50, overlapThreshold = 0.1, margin = 10 } = options;

  // Convert nodes to rectangles with dimensions
  const nodeRects: NodeRect[] = nodes.map((node) => {
    const width = (node.measured?.width ?? node.style?.width ?? node.width ?? 200) as number;
    const height = (node.measured?.height ?? node.style?.height ?? node.height ?? 100) as number;
    return {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width,
      height,
      parentId: node.parentId,
    };
  });

  // Separate nodes by parent (child nodes shouldn't push parent nodes)
  const topLevelNodes = nodeRects.filter((n) => !n.parentId);
  const childNodes = nodeRects.filter((n) => n.parentId);

  // Resolve collisions for top-level nodes
  resolveNodeCollisions(topLevelNodes, maxIterations, overlapThreshold, margin);

  // Resolve collisions for child nodes within their parent groups
  const parentGroups = new Map<string, NodeRect[]>();
  childNodes.forEach((node) => {
    if (node.parentId) {
      const group = parentGroups.get(node.parentId) || [];
      group.push(node);
      parentGroups.set(node.parentId, group);
    }
  });

  parentGroups.forEach((groupNodes) => {
    resolveNodeCollisions(groupNodes, maxIterations, overlapThreshold, margin);
  });

  // Map back to nodes with updated positions
  const rectMap = new Map<string, NodeRect>();
  [...topLevelNodes, ...childNodes].forEach((rect) => {
    rectMap.set(rect.id, rect);
  });

  return nodes.map((node) => {
    const rect = rectMap.get(node.id);
    if (rect && (rect.x !== node.position.x || rect.y !== node.position.y)) {
      return {
        ...node,
        position: { x: rect.x, y: rect.y },
      };
    }
    return node;
  });
}

function resolveNodeCollisions(
  rects: NodeRect[],
  maxIterations: number,
  overlapThreshold: number,
  margin: number
): void {
  let iterations = 0;
  let hasCollisions = true;

  while (hasCollisions && iterations < maxIterations) {
    hasCollisions = false;
    iterations++;

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const rectA = rects[i];
        const rectB = rects[j];

        const overlap = getOverlap(rectA, rectB, margin);

        if (overlap.x > overlapThreshold || overlap.y > overlapThreshold) {
          hasCollisions = true;

          // Calculate push direction and magnitude
          const centerAX = rectA.x + rectA.width / 2;
          const centerAY = rectA.y + rectA.height / 2;
          const centerBX = rectB.x + rectB.width / 2;
          const centerBY = rectB.y + rectB.height / 2;

          const dx = centerBX - centerAX;
          const dy = centerBY - centerAY;

          // Determine which axis has more overlap and push along that axis
          if (Math.abs(overlap.x) < Math.abs(overlap.y)) {
            // Push horizontally
            const pushX = (overlap.x + margin) / 2;
            if (dx >= 0) {
              rectA.x -= pushX;
              rectB.x += pushX;
            } else {
              rectA.x += pushX;
              rectB.x -= pushX;
            }
          } else {
            // Push vertically
            const pushY = (overlap.y + margin) / 2;
            if (dy >= 0) {
              rectA.y -= pushY;
              rectB.y += pushY;
            } else {
              rectA.y += pushY;
              rectB.y -= pushY;
            }
          }
        }
      }
    }
  }
}

function getOverlap(
  rectA: NodeRect,
  rectB: NodeRect,
  margin: number
): { x: number; y: number } {
  const overlapX = Math.min(
    rectA.x + rectA.width + margin - rectB.x,
    rectB.x + rectB.width + margin - rectA.x
  );

  const overlapY = Math.min(
    rectA.y + rectA.height + margin - rectB.y,
    rectB.y + rectB.height + margin - rectA.y
  );

  // If either overlap is negative, there's no collision
  if (overlapX <= 0 || overlapY <= 0) {
    return { x: 0, y: 0 };
  }

  return { x: overlapX, y: overlapY };
}
