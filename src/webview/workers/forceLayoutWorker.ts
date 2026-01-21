// Web Worker for force-directed layout calculation
// This runs the heavy d3-force simulation off the main thread

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  SimulationNodeDatum,
  SimulationLinkDatum,
} from 'd3-force';

// Node type for d3-force simulation
interface ForceNode extends SimulationNodeDatum {
  id: string;
  width: number;
  height: number;
}

// Edge type for d3-force simulation
interface ForceLink extends SimulationLinkDatum<ForceNode> {
  source: string | ForceNode;
  target: string | ForceNode;
}

// Input message type
interface LayoutInput {
  nodes: { id: string; width: number; height: number }[];
  edges: { source: string; target: string }[];
}

// Output message type
interface LayoutOutput {
  positions: [string, { x: number; y: number }][];
  error?: string;
}

// Listen for messages from the main thread
self.onmessage = (event: MessageEvent<LayoutInput>) => {
  const { nodes, edges } = event.data;
  
  try {
    const positions = calculateLayout(nodes, edges);
    
    // Convert Map to array for serialization
    const positionsArray: [string, { x: number; y: number }][] = Array.from(positions.entries());
    
    self.postMessage({ positions: positionsArray } as LayoutOutput);
  } catch (error) {
    console.error('Worker layout error:', error);
    
    // Fallback: position nodes in a simple grid
    const COLS = 8;
    const fallbackPositions: [string, { x: number; y: number }][] = nodes.map((node, index) => {
      const col = index % COLS;
      const row = Math.floor(index / COLS);
      return [
        node.id,
        {
          x: col * (node.width + 50) + 50,
          y: row * (node.height + 50) + 50,
        },
      ];
    });
    
    self.postMessage({ 
      positions: fallbackPositions,
      error: error instanceof Error ? error.message : 'Unknown error'
    } as LayoutOutput);
  }
};

function calculateLayout(
  nodes: { id: string; width: number; height: number }[],
  edges: { source: string; target: string }[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // If no nodes, return empty map
  if (nodes.length === 0) {
    return positions;
  }

  // For large graphs, use grid-based initial positions for stability
  const numNodes = nodes.length;
  const cols = Math.ceil(Math.sqrt(numNodes));
  const spacing = 250; // Space between nodes in initial grid
  const centerX = 5000;
  const centerY = 5000;
  const startX = centerX - (cols * spacing) / 2;
  const startY = centerY - (Math.ceil(numNodes / cols) * spacing) / 2;

  // Create node objects for d3-force with grid-based initial positions
  const forceNodes: ForceNode[] = nodes.map((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      id: node.id,
      width: node.width,
      height: node.height,
      x: startX + col * spacing,
      y: startY + row * spacing,
    };
  });

  // Create a map for quick node lookup
  const nodeMap = new Map(forceNodes.map((n) => [n.id, n]));

  // Create edge objects for d3-force (only for edges where both nodes exist)
  const forceLinks: ForceLink[] = edges
    .filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
    }));

  // Adjust parameters based on graph size for stability
  const isLargeGraph = numNodes > 100;
  const linkDistanceVal = isLargeGraph ? 150 : 100;
  const linkStrengthVal = isLargeGraph ? 0.3 : 0.5;
  const chargeStrengthVal = isLargeGraph ? -100 : -200;
  const iterationCount = isLargeGraph ? 150 : 300;

  // Create and run the force simulation
  const simulation = forceSimulation<ForceNode>(forceNodes)
    // Link force: pulls connected nodes together (like springs)
    .force(
      'link',
      forceLink<ForceNode, ForceLink>(forceLinks)
        .id((d) => d.id)
        .distance(linkDistanceVal)
        .strength(linkStrengthVal)
    )
    // Repulsion force: pushes all nodes apart to prevent overlap
    .force(
      'charge',
      forceManyBody<ForceNode>()
        .strength(chargeStrengthVal)
        .distanceMax(500) // Limit range of repulsion
    )
    // Centering force: keeps the graph centered
    .force('center', forceCenter(centerX, centerY))
    // Collision force: prevents node overlap
    .force(
      'collide',
      forceCollide<ForceNode>()
        .radius((d) => Math.max(d.width, d.height) / 2 + 15)
        .strength(0.5)
    )
    // Configure alpha decay for stability
    .alphaDecay(0.02)
    .velocityDecay(0.4)
    // Stop the simulation to run manually
    .stop();

  // Run the simulation synchronously
  for (let i = 0; i < iterationCount; i++) {
    simulation.tick();
  }

  // Extract final positions
  forceNodes.forEach((node) => {
    if (typeof node.x === 'number' && typeof node.y === 'number') {
      // Convert center position to top-left
      positions.set(node.id, {
        x: node.x - node.width / 2,
        y: node.y - node.height / 2,
      });
    }
  });

  return positions;
}
