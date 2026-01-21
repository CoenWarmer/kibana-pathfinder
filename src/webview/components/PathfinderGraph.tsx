import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  BackgroundVariant,
  MarkerType,
  ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  SimulationNodeDatum,
  SimulationLinkDatum,
} from 'd3-force';
import { FileNode as FileNodeType, NavigationEdge, GroupNode as GroupNodeType, FileSearchResult, ViewMode, PluginInfoForWebview } from '../../types';
import { FileNode } from './FileNode';
import { GroupNode } from './GroupNode';

// Calculate optimal handles based on relative node positions
function calculateHandles(
  sourcePos: { x: number; y: number },
  sourceWidth: number,
  sourceHeight: number,
  targetPos: { x: number; y: number },
  targetWidth: number,
  targetHeight: number
): { sourceHandle: string; targetHandle: string } {
  // Calculate center positions
  const sourceCenterX = sourcePos.x + sourceWidth / 2;
  const sourceCenterY = sourcePos.y + sourceHeight / 2;
  const targetCenterX = targetPos.x + targetWidth / 2;
  const targetCenterY = targetPos.y + targetHeight / 2;

  // Calculate direction vector
  const dx = targetCenterX - sourceCenterX;
  const dy = targetCenterY - sourceCenterY;

  // Determine which handles to use based on direction
  let sourceHandle: string;
  let targetHandle: string;

  if (Math.abs(dx) > Math.abs(dy)) {
    // More horizontal than vertical
    if (dx > 0) {
      // Target is to the right
      sourceHandle = 'right-source';
      targetHandle = 'left-target';
    } else {
      // Target is to the left
      sourceHandle = 'left-source';
      targetHandle = 'right-target';
    }
  } else {
    // More vertical than horizontal
    if (dy > 0) {
      // Target is below
      sourceHandle = 'bottom-source';
      targetHandle = 'top-target';
    } else {
      // Target is above
      sourceHandle = 'top-source';
      targetHandle = 'bottom-target';
    }
  }

  return { sourceHandle, targetHandle };
}

// Force-directed layout calculation using d3-force (optimizes for shortest edges)
interface ForceNode extends SimulationNodeDatum {
  id: string;
  width: number;
  height: number;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  source: string | ForceNode;
  target: string | ForceNode;
}

function calculateForceDirectedLayout(
  nodes: { id: string; width: number; height: number }[],
  edges: { source: string; target: string }[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  
  if (nodes.length === 0) {
    return positions;
  }

  // For large graphs, use a grid-based initial layout for stability
  const numNodes = nodes.length;
  const cols = Math.ceil(Math.sqrt(numNodes));
  const spacing = 350; // Larger initial spacing
  const centerX = 4000;
  const centerY = 4000;
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
  const linkDistanceVal = isLargeGraph ? 200 : 150; // Longer = more spread out
  const linkStrengthVal = isLargeGraph ? 0.3 : 0.5; // Lower = less clustering
  const chargeStrengthVal = isLargeGraph ? -400 : -300; // Stronger repulsion to prevent overlap
  const iterationCount = isLargeGraph ? 300 : 300;
  
  // Calculate collision radius based on node size plus padding
  const getCollisionRadius = (d: ForceNode) => Math.max(d.width, d.height) / 2 + 40;

  // Create and run the force simulation
  const simulation = forceSimulation<ForceNode>(forceNodes)
    // Link force: pulls connected nodes together (like springs)
    // This is the key force for minimizing edge lengths
    .force(
      'link',
      forceLink<ForceNode, ForceLink>(forceLinks)
        .id((d) => d.id)
        .distance(linkDistanceVal) // Target edge length
        .strength(linkStrengthVal) // How strongly edges pull nodes together
    )
    // Repulsion force: pushes all nodes apart to prevent overlap
    .force(
      'charge',
      forceManyBody<ForceNode>()
        .strength(chargeStrengthVal) // Negative = repulsion (stronger now)
        .distanceMax(800) // Increased range of repulsion
    )
    // Centering force: keeps the graph centered
    .force('center', forceCenter(centerX, centerY))
    // Collision force: prevents node overlap (stronger now)
    .force(
      'collide',
      forceCollide<ForceNode>()
        .radius(getCollisionRadius) // Larger collision radius
        .strength(1.0) // Full strength collision detection
        .iterations(3) // Multiple collision iterations per tick for better separation
    )
    // Configure alpha decay for smoother convergence
    .alphaDecay(0.015) // Slower decay = more iterations to settle
    .velocityDecay(0.25) // Less damping = nodes can move more freely
    // Stop the simulation to run manually
    .stop();

  // Run the simulation synchronously
  for (let i = 0; i < iterationCount; i++) {
    simulation.tick();
  }

  // Extract final positions (convert from center to top-left)
  forceNodes.forEach((node) => {
    if (typeof node.x === 'number' && typeof node.y === 'number') {
      positions.set(node.id, {
        x: Math.round(node.x - node.width / 2),
        y: Math.round(node.y - node.height / 2),
      });
    }
  });

  return positions;
}

interface PathfinderGraphProps {
  nodes: FileNodeType[];
  edges: NavigationEdge[];
  groups: GroupNodeType[];
  highlightedNodeId: string | null;
  activeNodeId: string | null;
  searchResults: { [pluginId: string]: FileSearchResult[] };
  viewMode: ViewMode;
  allPlugins: PluginInfoForWebview[];
  onNodeClick: (filePath: string) => void;
  onNodeDelete: (nodeId: string, filePath: string) => void;
  onClear: () => void;
  onStateChange: (nodes: FileNodeType[], edges: NavigationEdge[]) => void;
  onGroupsChange: (groups: GroupNodeType[]) => void;
  onSearchFiles: (pluginId: string, query: string) => void;
  onOpenPluginIndex: (pluginId: string) => void;
  onModeChange: (mode: ViewMode) => void;
}

// Custom node types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: any = {
  fileNode: FileNode,
  groupNode: GroupNode,
};

export function PathfinderGraph({
  nodes: inputNodes,
  edges: inputEdges,
  groups: inputGroups,
  highlightedNodeId,
  activeNodeId,
  searchResults,
  viewMode,
  allPlugins,
  onNodeClick,
  onNodeDelete,
  onClear,
  onStateChange,
  onGroupsChange,
  onSearchFiles,
  onOpenPluginIndex,
  onModeChange,
}: PathfinderGraphProps) {
  // Ref to store the React Flow instance for viewport manipulation
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const prevNodeCountRef = useRef<number>(inputNodes.length);

  // Center viewport on new nodes when they're added
  useEffect(() => {
    const prevCount = prevNodeCountRef.current;
    const currentCount = inputNodes.length;
    
    if (currentCount > prevCount && reactFlowInstance.current) {
      // A new node was added - find it (it's the last one)
      const newNode = inputNodes[inputNodes.length - 1];
      if (newNode) {
        // Calculate center position (account for group offset if node is in a group)
        let centerX = newNode.position.x + 100; // 100 = half of typical node width
        let centerY = newNode.position.y + 40; // 40 = half of typical node height
        
        // If node is in a group, add the group's position
        // Use cached complete mode positions first (for Complete mode), then fall back to inputGroups
        if (newNode.groupId) {
          const cachedPosition = completePositionsRef.current.get(newNode.groupId);
          if (cachedPosition) {
            centerX += cachedPosition.x;
            centerY += cachedPosition.y;
          } else {
            const group = inputGroups.find(g => g.id === newNode.groupId);
            if (group) {
              centerX += group.position.x;
              centerY += group.position.y;
            }
          }
        }
        
        // Center viewport on the new node with a smooth transition
        setTimeout(() => {
          reactFlowInstance.current?.setCenter(centerX, centerY, { zoom: 1, duration: 300 });
        }, 50);
      }
    }
    
    prevNodeCountRef.current = currentCount;
  }, [inputNodes, inputGroups]);

  // Generate edges for complete mode (plugin dependencies)
  // This needs to be calculated first so we can use it for layout
  const completeEdges = useMemo((): NavigationEdge[] => {
    if (viewMode !== 'complete' || allPlugins.length === 0) {
      return [];
    }

    const existingEdgeIds = new Set(inputEdges.map((e) => e.id));
    const edges: NavigationEdge[] = [];

    for (const plugin of allPlugins) {
      const sourceGroupId = `group-${plugin.runtimeId}`;
      
      for (const depRuntimeId of plugin.requiredPlugins) {
        const targetGroupId = `group-${depRuntimeId}`;
        const edgeId = `dep-${targetGroupId}-${sourceGroupId}`;
        
        // Skip if edge already exists
        if (existingEdgeIds.has(edgeId)) continue;
        
        // Check if target plugin exists
        const targetExists = allPlugins.some((p) => p.runtimeId === depRuntimeId);
        if (!targetExists) continue;

        edges.push({
          id: edgeId,
          source: targetGroupId,
          target: sourceGroupId,
          edgeType: 'dependency',
        });
      }
    }

    return edges;
  }, [viewMode, allPlugins, inputEdges]);

  // State for complete mode groups and loading indicator
  const [completeGroups, setCompleteGroups] = useState<GroupNodeType[]>([]);
  const [isCalculatingLayout, setIsCalculatingLayout] = useState(false);
  
  // State for plugin search in Complete mode
  const [pluginSearchQuery, setPluginSearchQuery] = useState('');
  const [isSearchDropdownOpen, setIsSearchDropdownOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  // Track whether we've already calculated the layout for the current complete mode session
  const hasCalculatedLayoutRef = useRef(false);

  // Reset layout flag when leaving complete mode
  useEffect(() => {
    if (viewMode !== 'complete') {
      hasCalculatedLayoutRef.current = false;
    }
  }, [viewMode]);

  // Generate groups for complete mode from all plugins with force-directed layout
  // Only calculate ONCE when entering Complete mode to avoid repositioning on group changes
  useEffect(() => {
    if (viewMode !== 'complete' || allPlugins.length === 0) {
      setCompleteGroups([]);
      setIsCalculatingLayout(false);
      return;
    }

    // Skip if we've already calculated the layout for this complete mode session
    if (hasCalculatedLayoutRef.current) {
      return;
    }

    // Set loading state
    setIsCalculatingLayout(true);

    // Use setTimeout to allow the UI to update before heavy calculation
    const timeoutId = setTimeout(() => {
      // Layout constants for complete mode
      const GROUP_WIDTH = 180;
      const GROUP_HEIGHT = 50;

      // Layout ALL plugins (not just those not in inputGroups)
      // This ensures consistent positioning regardless of which files are open
      const layoutNodes = allPlugins.map((plugin) => ({
        id: `group-${plugin.runtimeId}`,
        width: GROUP_WIDTH,
        height: GROUP_HEIGHT,
      }));

      // Prepare edges for force layout
      const layoutEdges = completeEdges.map((edge) => ({
        source: edge.source,
        target: edge.target,
      }));

      // Calculate force-directed layout on main thread
      const positions = calculateForceDirectedLayout(layoutNodes, layoutEdges);
      
      // Store ALL positions in the cache for later use
      positions.forEach((pos, id) => {
        completePositionsRef.current.set(id, pos);
      });

      // Generate groups for plugins NOT already in inputGroups
      const existingGroupIds = new Set(inputGroups.map((g) => g.id));
      
      const groups = allPlugins
        .filter((plugin) => !existingGroupIds.has(`group-${plugin.runtimeId}`))
        .map((plugin) => {
          const groupId = `group-${plugin.runtimeId}`;
          const position = positions.get(groupId) || { x: 0, y: 0 };
          
          return {
            id: groupId,
            label: plugin.packageId || plugin.runtimeId,
            type: 'dependency' as const,
            position,
            width: GROUP_WIDTH,
            height: GROUP_HEIGHT,
            requiredPlugins: plugin.requiredPlugins,
          };
        });

      setCompleteGroups(groups);
      setIsCalculatingLayout(false);
      hasCalculatedLayoutRef.current = true;
    }, 50);

    return () => clearTimeout(timeoutId);
  }, [viewMode, allPlugins, completeEdges, inputGroups]);

  // Cache for storing computed positions from complete mode layout
  // This allows us to preserve positions when groups transition from completeGroups to inputGroups
  const completePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Update the position cache whenever completeGroups changes
  useEffect(() => {
    completeGroups.forEach((group) => {
      completePositionsRef.current.set(group.id, group.position);
    });
  }, [completeGroups]);

  // Filtered plugin search results
  const filteredPluginResults = useMemo(() => {
    if (!pluginSearchQuery.trim() || viewMode !== 'complete') {
      return [];
    }
    const query = pluginSearchQuery.toLowerCase();
    return allPlugins
      .filter((plugin) => 
        plugin.packageId.toLowerCase().includes(query) ||
        plugin.runtimeId.toLowerCase().includes(query)
      )
      .slice(0, 10); // Limit to 10 results
  }, [pluginSearchQuery, allPlugins, viewMode]);

  // Handle plugin selection from search
  const handlePluginSearchSelect = useCallback((plugin: PluginInfoForWebview) => {
    const groupId = `group-${plugin.runtimeId}`;
    const position = completePositionsRef.current.get(groupId);
    
    // Clear search immediately
    setPluginSearchQuery('');
    setIsSearchDropdownOpen(false);
    
    if (position && reactFlowInstance.current) {
      // Zoom to the plugin node first
      const GROUP_WIDTH = 180;
      const GROUP_HEIGHT = 50;
      const centerX = position.x + GROUP_WIDTH / 2;
      const centerY = position.y + GROUP_HEIGHT / 2;
      
      reactFlowInstance.current.setCenter(centerX, centerY, { zoom: 1.5, duration: 500 });
      
      // Wait for animation to complete, then open the file
      setTimeout(() => {
        onOpenPluginIndex(plugin.packageId);
      }, 600); // 500ms animation + 100ms buffer
    } else {
      // No position found, just open the file
      onOpenPluginIndex(plugin.packageId);
    }
  }, [onOpenPluginIndex]);

  // Handle keyboard navigation in search
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedSearchIndex((prev) => Math.min(prev + 1, filteredPluginResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedSearchIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filteredPluginResults.length > 0) {
      e.preventDefault();
      handlePluginSearchSelect(filteredPluginResults[selectedSearchIndex]);
    } else if (e.key === 'Escape') {
      setIsSearchDropdownOpen(false);
      setPluginSearchQuery('');
    }
  }, [filteredPluginResults, selectedSearchIndex, handlePluginSearchSelect]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedSearchIndex(0);
  }, [filteredPluginResults]);

  // Filter groups based on viewMode
  const filteredGroups = useMemo(() => {
    console.log('[filteredGroups] viewMode:', viewMode, 'inputGroups:', inputGroups.length, 'completeGroups:', completeGroups.length);
    
    if (viewMode === 'journey') {
      // Journey mode: only show plugin groups (no dependency groups)
      const result = inputGroups.filter((g) => g.type === 'plugin');
      console.log('[filteredGroups] Journey mode, returning', result.length, 'groups');
      return result;
    }
    if (viewMode === 'complete') {
      // Complete mode: combine existing groups with all plugins
      // For inputGroups, use cached positions from completeGroups if available
      const inputGroupIds = new Set(inputGroups.map((g) => g.id));
      const inputGroupsWithPreservedPositions = inputGroups.map((group) => {
        const cachedPosition = completePositionsRef.current.get(group.id);
        if (cachedPosition) {
          return { ...group, position: cachedPosition };
        }
        return group;
      });
      // Filter out completeGroups that are now in inputGroups to avoid duplicates
      const remainingCompleteGroups = completeGroups.filter(
        (g) => !inputGroupIds.has(g.id)
      );
      const result = [...inputGroupsWithPreservedPositions, ...remainingCompleteGroups];
      console.log('[filteredGroups] Complete mode, returning', result.length, 'groups (input:', inputGroupsWithPreservedPositions.length, '+ complete:', remainingCompleteGroups.length, ')');
      console.log('[filteredGroups] Sample group:', result[0]);
      return result;
    }
    // Plugin mode: show all existing groups
    console.log('[filteredGroups] Plugin mode, returning', inputGroups.length, 'groups');
    return inputGroups;
  }, [inputGroups, viewMode, completeGroups]);

  // Convert groups to React Flow nodes
  const groupFlowNodes: Node[] = useMemo(
    () =>
      filteredGroups.map((group) => {
        const nodesInGroup = inputNodes.filter((n) => n.groupId === group.id);
        const isDependency = group.type === 'dependency';
        const isEmpty = nodesInGroup.length === 0;
        
        // Use compact size for empty dependency groups
        const width = isDependency && isEmpty ? 200 : group.width;
        const height = isDependency && isEmpty ? 50 : group.height;
        
        return {
          id: group.id,
          type: 'groupNode',
          position: group.position,
          data: {
            label: group.label,
            groupType: group.type,
            hasNodes: nodesInGroup.length > 0,
            searchResults: searchResults[group.label] || [],
            onSearch: onSearchFiles,
            onFileSelect: onNodeClick,
            onOpenPluginIndex: onOpenPluginIndex,
            isCompleteMode: viewMode === 'complete',
          },
          style: {
            width,
            height,
          },
        };
      }),
    [filteredGroups, inputNodes, searchResults, onSearchFiles, onNodeClick, onOpenPluginIndex, viewMode]
  );

  // Convert file nodes to React Flow nodes
  const fileFlowNodes: Node[] = useMemo(
    () =>
      inputNodes.map((node) => ({
        id: node.id,
        type: 'fileNode',
        position: node.position,
        parentId: node.groupId,
        extent: node.groupId ? 'parent' as const : undefined,
        data: {
          label: node.fileName,
          filePath: node.filePath,
          relativePath: node.relativePath,
          pluginName: node.pluginName,
          isHighlighted: node.id === highlightedNodeId,
          isActive: node.id === activeNodeId,
          onDelete: () => onNodeDelete(node.id, node.filePath),
          onClick: () => onNodeClick(node.filePath),
        },
      })),
    [inputNodes, highlightedNodeId, activeNodeId, onNodeClick, onNodeDelete]
  );

  // Combine group and file nodes (groups must come first)
  const flowNodes = useMemo(() => {
    const result = [...groupFlowNodes, ...fileFlowNodes];
    console.log('[flowNodes] groupFlowNodes:', groupFlowNodes.length, 'fileFlowNodes:', fileFlowNodes.length, 'total:', result.length);
    return result;
  }, [groupFlowNodes, fileFlowNodes]);

  // Filter edges based on viewMode
  const filteredEdges = useMemo(() => {
    // Build a set of valid node/group IDs for quick lookup
    const validNodeIds = new Set([
      ...inputNodes.map((n) => n.id),
      ...filteredGroups.map((g) => g.id),
    ]);

    // Helper to check if an edge has valid endpoints
    const hasValidEndpoints = (edge: NavigationEdge) => {
      return validNodeIds.has(edge.source) && validNodeIds.has(edge.target);
    };

    if (viewMode === 'journey') {
      // Journey mode: only show navigation edges (no dependency edges)
      return inputEdges.filter((edge) => {
        const isDependencyEdge = 
          edge.edgeType === 'dependency' || 
          edge.id.startsWith('dep-') ||
          (edge.source.startsWith('group-') && edge.target.startsWith('group-'));
        return !isDependencyEdge && hasValidEndpoints(edge);
      });
    }
    if (viewMode === 'complete') {
      // Complete mode: combine existing edges with all plugin dependency edges
      // Filter to only include edges with valid endpoints
      // Deduplicate by edge ID to prevent React key warnings
      const allEdges = [...inputEdges, ...completeEdges];
      const seenIds = new Set<string>();
      const uniqueEdges: NavigationEdge[] = [];
      for (const edge of allEdges) {
        if (!seenIds.has(edge.id) && hasValidEndpoints(edge)) {
          seenIds.add(edge.id);
          uniqueEdges.push(edge);
        }
      }
      return uniqueEdges;
    }
    // Plugin mode: show all existing edges with valid endpoints
    return inputEdges.filter(hasValidEndpoints);
  }, [inputEdges, viewMode, completeEdges, inputNodes, filteredGroups]);

  // Convert edges to React Flow edges
  const flowEdges: Edge[] = useMemo(
    () =>
      filteredEdges.map((edge) => {
        // Check if this is a dependency edge:
        // 1. Has edgeType === 'dependency'
        // 2. ID starts with 'dep-'
        // 3. Both source and target are group IDs (start with 'group-')
        const isDependencyEdge = 
          edge.edgeType === 'dependency' || 
          edge.id.startsWith('dep-') ||
          (edge.source.startsWith('group-') && edge.target.startsWith('group-'));
        
        if (isDependencyEdge) {
          // Calculate handles dynamically if not provided
          let sourceHandle = edge.sourceHandle;
          let targetHandle = edge.targetHandle;
          
          if (!sourceHandle || !targetHandle) {
            // Find source and target groups to get their positions
            const sourceGroup = filteredGroups.find((g) => g.id === edge.source);
            const targetGroup = filteredGroups.find((g) => g.id === edge.target);
            
            if (sourceGroup && targetGroup) {
              const handles = calculateHandles(
                sourceGroup.position,
                sourceGroup.width,
                sourceGroup.height,
                targetGroup.position,
                targetGroup.width,
                targetGroup.height
              );
              sourceHandle = handles.sourceHandle;
              targetHandle = handles.targetHandle;
            }
          }
          
          // Dependency edges: solid, dark grey, pointing from dependency to plugin
          // In Complete mode, use lower opacity to reduce visual clutter
          const edgeOpacity = viewMode === 'complete' ? 0.2 : 0.6;
          
          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle,
            targetHandle,
            type: 'default',
            animated: false,
            className: 'dependency-edge',
            style: { 
              stroke: '#666666',
              strokeWidth: 1.5,
              opacity: edgeOpacity,
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: '#666666',
              width: 12,
              height: 12,
            },
          };
        }
        
        // Navigation edges: animated, blue
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          animated: true,
          style: { stroke: 'var(--vscode-charts-blue, #4fc3f7)', strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: 'var(--vscode-charts-blue, #4fc3f7)',
          },
        };
      }),
    [filteredEdges, filteredGroups, viewMode]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  // Sync external nodes/edges with internal state
  React.useEffect(() => {
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  React.useEffect(() => {
    setEdges(flowEdges);
  }, [flowEdges, setEdges]);

  // Handle node position changes
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);

      const positionChanges = changes.filter(
        (change) => change.type === 'position' && change.dragging === false
      );

      if (positionChanges.length > 0) {
        // Update file nodes
        const updatedNodes = inputNodes.map((node) => {
          const flowNode = nodes.find((n) => n.id === node.id);
          if (flowNode) {
            return { ...node, position: flowNode.position };
          }
          return node;
        });
        onStateChange(updatedNodes, inputEdges);

        // Update groups
        const updatedGroups = inputGroups.map((group) => {
          const flowNode = nodes.find((n) => n.id === group.id);
          if (flowNode) {
            return { ...group, position: flowNode.position };
          }
          return group;
        });
        onGroupsChange(updatedGroups);
      }
    },
    [onNodesChange, inputNodes, inputEdges, inputGroups, nodes, onStateChange, onGroupsChange]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
    },
    [onEdgesChange]
  );

  const modes: ViewMode[] = ['journey', 'plugin', 'complete'];

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Top controls bar */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 10,
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
        }}
      >
        {/* Plugin search (Complete mode only) */}
        {viewMode === 'complete' && (
          <div style={{ position: 'relative' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={pluginSearchQuery}
              onChange={(e) => {
                setPluginSearchQuery(e.target.value);
                setIsSearchDropdownOpen(true);
              }}
              onFocus={() => setIsSearchDropdownOpen(true)}
              onBlur={() => {
                // Delay to allow click on dropdown item
                setTimeout(() => setIsSearchDropdownOpen(false), 200);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search plugins..."
              style={{
                padding: '6px 10px',
                width: '200px',
                background: 'var(--vscode-input-background)',
                color: 'var(--vscode-input-foreground)',
                border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
                borderRadius: '4px',
                fontSize: '12px',
                fontFamily: 'var(--vscode-font-family)',
                outline: 'none',
              }}
            />
            {/* Search dropdown */}
            {isSearchDropdownOpen && filteredPluginResults.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '4px',
                  background: 'var(--vscode-dropdown-background)',
                  border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
                  borderRadius: '4px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                  maxHeight: '300px',
                  overflowY: 'auto',
                  zIndex: 100,
                }}
              >
                {filteredPluginResults.map((plugin, index) => (
                  <div
                    key={plugin.runtimeId}
                    onClick={() => handlePluginSearchSelect(plugin)}
                    style={{
                      padding: '8px 10px',
                      cursor: 'pointer',
                      background: index === selectedSearchIndex 
                        ? 'var(--vscode-list-activeSelectionBackground)' 
                        : 'transparent',
                      color: index === selectedSearchIndex
                        ? 'var(--vscode-list-activeSelectionForeground)'
                        : 'var(--vscode-dropdown-foreground)',
                      fontSize: '12px',
                      fontFamily: 'var(--vscode-font-family)',
                      borderBottom: index < filteredPluginResults.length - 1 
                        ? '1px solid var(--vscode-panel-border)' 
                        : 'none',
                    }}
                    onMouseEnter={() => setSelectedSearchIndex(index)}
                  >
                    <div style={{ fontWeight: 500 }}>{plugin.packageId}</div>
                    <div style={{ 
                      fontSize: '10px', 
                      opacity: 0.7,
                      marginTop: '2px',
                    }}>
                      {plugin.runtimeId}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mode toggle */}
        <div
          style={{
            display: 'flex',
            background: 'var(--vscode-editor-background)',
            border: '1px solid var(--vscode-panel-border)',
            borderRadius: '4px',
            overflow: 'hidden',
          }}
        >
          {modes.map((mode) => {
            const isLoading = mode === 'complete' && isCalculatingLayout;
            const isActive = viewMode === mode;
            
            return (
              <button
                key={mode}
                onClick={() => onModeChange(mode)}
                disabled={isLoading}
                style={{
                  padding: '6px 12px',
                  background: isActive 
                    ? 'var(--vscode-button-background)' 
                    : 'transparent',
                  color: isActive 
                    ? 'var(--vscode-button-foreground)' 
                    : 'var(--vscode-foreground)',
                  border: 'none',
                  cursor: isLoading ? 'wait' : 'pointer',
                  fontSize: '11px',
                  fontFamily: 'var(--vscode-font-family)',
                  textTransform: 'capitalize',
                  transition: 'all 0.15s ease',
                  opacity: isLoading ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                title={isLoading ? 'Calculating layout...' : `${mode} mode`}
              >
                {isLoading && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: '10px',
                      height: '10px',
                      border: '2px solid currentColor',
                      borderTopColor: 'transparent',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                )}
                {mode}
              </button>
            );
          })}
        </div>

        {/* Clear button */}
        <button
          onClick={onClear}
          style={{
            padding: '6px 12px',
            background: 'var(--vscode-button-secondaryBackground)',
            color: 'var(--vscode-button-secondaryForeground)',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
            fontFamily: 'var(--vscode-font-family)',
          }}
          title="Clear all nodes"
        >
          Clear
        </button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onInit={(instance) => {
          reactFlowInstance.current = instance;
        }}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Controls
          style={{
            background: 'var(--vscode-editor-background)',
            border: '1px solid var(--vscode-panel-border)',
            borderRadius: '4px',
          }}
        />
        <MiniMap
          style={{
            background: 'var(--vscode-editor-background)',
            border: '1px solid var(--vscode-panel-border)',
          }}
          nodeColor={(node) => {
            if (node.type === 'groupNode') {
              return 'var(--vscode-charts-purple, #c586c0)';
            }
            return node.data?.isHighlighted
              ? 'var(--vscode-charts-yellow, #ffeb3b)'
              : 'var(--vscode-charts-blue, #4fc3f7)';
          }}
          maskColor="rgba(0, 0, 0, 0.5)"
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--vscode-editorLineNumber-foreground)"
        />
      </ReactFlow>

      {/* Loading state for complete mode */}
      {viewMode === 'complete' && allPlugins.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: 'var(--vscode-descriptionForeground)',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontSize: '14px' }}>Loading plugins...</div>
        </div>
      )}

      {/* Empty state - only show in journey/plugin mode when no nodes */}
      {viewMode !== 'complete' && inputNodes.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: 'var(--vscode-descriptionForeground)',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}>🗺️</div>
          <div style={{ fontSize: '14px' }}>
            Start navigating through files
            <br />
            to build your map
          </div>
        </div>
      )}
    </div>
  );
}
