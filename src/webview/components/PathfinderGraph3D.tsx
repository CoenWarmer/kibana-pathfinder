import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { PluginInfoForWebview, ViewMode, FileNode, NavigationEdge, GroupNode } from '../../types';

// Lazy load Deck.gl to prevent blocking
let DeckGL: any = null;
let ScatterplotLayer: any = null;
let ArcLayer: any = null;
let TextLayer: any = null;
let OrbitView: any = null;
let LinearInterpolator: any = null;
let PointCloudLayer: any = null;

// Node data structure for 3D visualization
interface Node3D {
  id: string;
  packageId: string;
  runtimeId: string;
  position: [number, number, number]; // [x, y, z]
  depth: number;
  dependentCount: number; // How many plugins depend on this one
  dependencyCount: number; // How many plugins this depends on
  type: 'plugin' | 'file';
  radius: number;
  color: [number, number, number, number];
  label: string;
}

// Edge data structure for 3D visualization
interface Edge3D {
  source: Node3D;
  target: Node3D;
  type: 'dependency' | 'navigation';
}

interface PathfinderGraph3DProps {
  allPlugins: PluginInfoForWebview[];
  fileNodes: FileNode[];
  fileEdges: NavigationEdge[];
  groups: GroupNode[];
  activeNodeId: string | null;
  onPluginClick: (pluginId: string) => void;
  onPluginDoubleClick: (pluginId: string) => void;
  onFileClick: (filePath: string) => void;
  onModeChange: (mode: ViewMode) => void;
  onClear: () => void;
}

// Cubic bezier easing function (ease-out-cubic for smooth deceleration)
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// Calculate dependency depths using memoized DFS - O(V+E) algorithm
function calculateDependencyDepths(
  plugins: PluginInfoForWebview[]
): Map<string, number> {
  const depths = new Map<string, number>();
  const pluginMap = new Map(plugins.map((p) => [p.runtimeId, p]));
  const visiting = new Set<string>();
  
  const dependents = new Map<string, string[]>();
  for (const plugin of plugins) {
    dependents.set(plugin.runtimeId, []);
  }
  for (const plugin of plugins) {
    for (const dep of plugin.requiredPlugins) {
      if (dependents.has(dep)) {
        dependents.get(dep)!.push(plugin.runtimeId);
      }
    }
  }
  
  function getDepth(id: string): number {
    if (depths.has(id)) {
      return depths.get(id)!;
    }
    
    if (visiting.has(id)) {
      return 0;
    }
    
    visiting.add(id);
    
    const deps = dependents.get(id) || [];
    if (deps.length === 0) {
      depths.set(id, 0);
      visiting.delete(id);
      return 0;
    }
    
    let maxDependentDepth = 0;
    for (const depId of deps) {
      maxDependentDepth = Math.max(maxDependentDepth, getDepth(depId));
    }
    
    const depth = maxDependentDepth + 1;
    depths.set(id, depth);
    visiting.delete(id);
    return depth;
  }
  
  for (const plugin of plugins) {
    getDepth(plugin.runtimeId);
  }
  
  return depths;
}

// Calculate how many plugins depend on each plugin
function calculateDependentCounts(
  plugins: PluginInfoForWebview[]
): Map<string, number> {
  const counts = new Map<string, number>();
  
  for (const plugin of plugins) {
    counts.set(plugin.runtimeId, 0);
  }
  
  for (const plugin of plugins) {
    for (const dep of plugin.requiredPlugins) {
      if (counts.has(dep)) {
        counts.set(dep, counts.get(dep)! + 1);
      }
    }
  }
  
  return counts;
}

export function PathfinderGraph3D({
  allPlugins,
  fileNodes,
  fileEdges,
  groups,
  activeNodeId,
  onPluginClick,
  onPluginDoubleClick,
  onFileClick,
  onModeChange,
  onClear,
}: PathfinderGraph3DProps) {
  const modes: ViewMode[] = ['journey', 'plugin', 'complete', '3d'];
  const [hoveredNode, setHoveredNode] = useState<Node3D | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deckGlReady, setDeckGlReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewState, setViewState] = useState({
    target: [0, 0, 300] as [number, number, number],
    rotationX: 30,
    rotationOrbit: 0,
    zoom: -0.5,
    minZoom: -2,
    maxZoom: 5,
  });

  // Lazy load Deck.gl modules
  useEffect(() => {
    let mounted = true;
    
    const loadDeckGl = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (!mounted) return;
        
        const deckReact = await import('@deck.gl/react');
        if (!mounted) return;
        
        const deckLayers = await import('@deck.gl/layers');
        if (!mounted) return;
        
        const deckCore = await import('@deck.gl/core');
        if (!mounted) return;
        
        DeckGL = deckReact.default;
        ScatterplotLayer = deckLayers.ScatterplotLayer;
        ArcLayer = deckLayers.ArcLayer;
        TextLayer = deckLayers.TextLayer;
        PointCloudLayer = deckLayers.PointCloudLayer;
        OrbitView = deckCore.OrbitView;
        LinearInterpolator = deckCore.LinearInterpolator;
        
        setDeckGlReady(true);
        setIsLoading(false);
      } catch (err) {
        if (mounted) {
          setError('Failed to initialize 3D view: ' + (err as Error).message);
          setIsLoading(false);
        }
      }
    };
    
    loadDeckGl();
    
    return () => {
      mounted = false;
    };
  }, []);

  // Calculate 3D node positions for plugins and files
  const { nodes, edges, maxDepth } = useMemo(() => {
    if (allPlugins.length === 0) {
      return { nodes: [], edges: [], maxDepth: 0 };
    }

    const depths = calculateDependencyDepths(allPlugins);
    const dependentCounts = calculateDependentCounts(allPlugins);
    const maxDepthValue = Math.max(...depths.values(), 1);
    
    const nodeMap = new Map<string, Node3D>();
    const nodes3D: Node3D[] = [];
    const edges3D: Edge3D[] = [];
    
    // Group plugins by depth for circular layout
    const nodesByDepth = new Map<number, PluginInfoForWebview[]>();
    for (const plugin of allPlugins) {
      const depth = depths.get(plugin.runtimeId) || 0;
      if (!nodesByDepth.has(depth)) {
        nodesByDepth.set(depth, []);
      }
      nodesByDepth.get(depth)!.push(plugin);
    }
    
    // Create plugin nodes
    const zSpacing = 100;
    const baseRadius = 200;
    
    // Color scale function
    const getPluginColor = (depth: number): [number, number, number, number] => {
      const t = maxDepthValue > 0 ? depth / maxDepthValue : 0;
      const r = Math.round(138 * (1 - t) + 0 * t);
      const g = Math.round(43 * (1 - t) + 188 * t);
      const b = Math.round(226 * (1 - t) + 212 * t);
      return [r, g, b, 220];
    };
    
    for (const [depth, pluginsAtDepth] of nodesByDepth) {
      const count = pluginsAtDepth.length;
      const radius = baseRadius + count * 5;
      
      pluginsAtDepth.forEach((plugin, index) => {
        const angle = (2 * Math.PI * index) / count;
        const x = radius * Math.cos(angle);
        const y = radius * Math.sin(angle);
        const z = (maxDepthValue - depth) * zSpacing;
        
        const dependentCount = dependentCounts.get(plugin.runtimeId) || 0;
        const nodeRadius = 8 + Math.min(dependentCount * 2, 20);
        
        const node: Node3D = {
          id: plugin.runtimeId,
          packageId: plugin.packageId,
          runtimeId: plugin.runtimeId,
          position: [x, y, z],
          depth,
          dependentCount,
          dependencyCount: plugin.requiredPlugins.length,
          type: 'plugin',
          radius: nodeRadius,
          color: getPluginColor(depth),
          label: plugin.packageId.replace('@kbn/', ''),
        };
        
        nodes3D.push(node);
        nodeMap.set(plugin.runtimeId, node);
      });
    }
    
    // Create file nodes positioned around their parent plugin
    // Build a lookup map for plugins by both runtimeId and packageId
    const pluginLookup = new Map<string, Node3D>();
    for (const [id, node] of nodeMap) {
      if (node.type === 'plugin') {
        pluginLookup.set(id, node); // runtimeId
        pluginLookup.set(node.packageId, node); // full packageId like @kbn/share-plugin
        // Also try without @kbn/ prefix
        const shortName = node.packageId.replace('@kbn/', '').replace('-plugin', '');
        pluginLookup.set(shortName, node);
      }
    }
    
    const filesByPlugin = new Map<string, { parent: Node3D; files: FileNode[] }>();
    const orphanFiles: FileNode[] = [];
    
    for (const file of fileNodes) {
      const pluginId = file.pluginName || file.groupId?.replace('group-', '') || 'unknown';
      
      // Try to find parent plugin with various ID formats
      let parentNode = pluginLookup.get(pluginId);
      if (!parentNode && file.groupId) {
        parentNode = pluginLookup.get(file.groupId.replace('group-', ''));
      }
      
      if (parentNode) {
        if (!filesByPlugin.has(parentNode.id)) {
          filesByPlugin.set(parentNode.id, { parent: parentNode, files: [] });
        }
        filesByPlugin.get(parentNode.id)!.files.push(file);
      } else {
        orphanFiles.push(file);
      }
    }
    
    // Position files around their parent plugins
    for (const [, { parent, files }] of filesByPlugin) {
      const fileRadius = 30; // Distance from parent plugin
      const fileCount = files.length;
      
      files.forEach((file, index) => {
        const angle = (2 * Math.PI * index) / Math.max(fileCount, 1);
        const offsetX = fileRadius * Math.cos(angle);
        const offsetY = fileRadius * Math.sin(angle);
        
        const fileNode: Node3D = {
          id: file.id,
          packageId: file.filePath,
          runtimeId: file.id,
          position: [
            parent.position[0] + offsetX,
            parent.position[1] + offsetY,
            parent.position[2] + 15, // Above parent
          ],
          depth: parent.depth,
          dependentCount: 0,
          dependencyCount: 0,
          type: 'file',
          radius: 5, // Smaller than plugins
          color: [255, 180, 50, 255], // Bright orange/gold for files
          label: file.fileName,
        };
        
        nodes3D.push(fileNode);
        nodeMap.set(file.id, fileNode);
        
        // Create edge from file to parent plugin
        edges3D.push({
          source: fileNode,
          target: parent,
          type: 'navigation',
        });
      });
    }
    
    // Position orphan files (no matching plugin) in the center
    if (orphanFiles.length > 0) {
      const orphanRadius = 50;
      orphanFiles.forEach((file, index) => {
        const angle = (2 * Math.PI * index) / orphanFiles.length;
        const fileNode: Node3D = {
          id: file.id,
          packageId: file.filePath,
          runtimeId: file.id,
          position: [
            orphanRadius * Math.cos(angle),
            orphanRadius * Math.sin(angle),
            maxDepthValue * zSpacing / 2, // Middle of the Z range
          ],
          depth: 0,
          dependentCount: 0,
          dependencyCount: 0,
          type: 'file',
          radius: 5,
          color: [255, 100, 100, 255], // Red for orphan files
          label: file.fileName,
        };
        
        nodes3D.push(fileNode);
        nodeMap.set(file.id, fileNode);
      });
    }
    
    // Create dependency edges between plugins
    for (const plugin of allPlugins) {
      const sourceNode = nodeMap.get(plugin.runtimeId);
      if (!sourceNode) continue;
      
      for (const depId of plugin.requiredPlugins) {
        const targetNode = nodeMap.get(depId);
        if (targetNode) {
          edges3D.push({
            source: sourceNode,
            target: targetNode,
            type: 'dependency',
          });
        }
      }
    }
    
    // Create navigation edges between files
    for (const edge of fileEdges) {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (sourceNode && targetNode) {
        edges3D.push({
          source: sourceNode,
          target: targetNode,
          type: 'navigation',
        });
      }
    }
    
    return { nodes: nodes3D, edges: edges3D, maxDepth: maxDepthValue };
  }, [allPlugins, fileNodes, fileEdges]);

  // Center camera on graph when nodes are calculated (initial load only)
  const hasInitializedCamera = React.useRef(false);
  useEffect(() => {
    if (nodes.length > 0 && maxDepth > 0 && !hasInitializedCamera.current) {
      hasInitializedCamera.current = true;
      const zCenter = (maxDepth * 100) / 2;
      setViewState((prev) => ({
        ...prev,
        target: [0, 0, zCenter] as [number, number, number],
      }));
    }
  }, [nodes.length, maxDepth]);

  // Track previous active node to detect focus changes
  const prevActiveNodeIdRef = React.useRef<string | null>(null);
  
  // Pan and zoom to active node when it changes (file focus changes)
  useEffect(() => {
    // Skip if no active node or it hasn't changed
    if (!activeNodeId || activeNodeId === prevActiveNodeIdRef.current) {
      prevActiveNodeIdRef.current = activeNodeId;
      return;
    }
    
    // Find the corresponding 3D node (could be a file node)
    const activeNode3D = nodes.find(n => n.id === activeNodeId);
    
    if (activeNode3D && LinearInterpolator && deckGlReady) {
      // Animate to the active node
      setViewState((prev) => ({
        ...prev,
        target: activeNode3D.position,
        zoom: 3.5, // Zoom in close
        transitionDuration: 600,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
        transitionEasing: easeOutCubic,
      }));
    }
    
    prevActiveNodeIdRef.current = activeNodeId;
  }, [activeNodeId, nodes, deckGlReady]);

  // Handle node click
  const handleNodeClick = useCallback(
    (info: { object?: Node3D }) => {
      if (info.object) {
        const node = info.object;
        
        // Zoom and center on the clicked node
        setViewState((prev) => ({
          ...prev,
          target: node.position,
          zoom: 3.5,
          transitionDuration: 600,
          transitionInterpolator: LinearInterpolator ? new LinearInterpolator(['target', 'zoom']) : undefined,
          transitionEasing: easeOutCubic,
        }));
        
        // Open file or plugin after animation
        setTimeout(() => {
          if (node.type === 'file') {
            onFileClick(node.packageId); // packageId contains filePath for files
          } else {
            onPluginClick(node.packageId);
          }
        }, 700);
      }
    },
    [onPluginClick, onFileClick]
  );

  // Handle hover
  const handleHover = useCallback((info: { object?: Node3D }) => {
    setHoveredNode(info.object || null);
  }, []);

  // Create Deck.gl layers
  const layers = useMemo(() => {
    if (!ScatterplotLayer || !ArcLayer || !TextLayer) {
      return [];
    }

    // Separate plugins and files for different rendering
    const pluginNodes = nodes.filter(n => n.type === 'plugin');
    const fileNodesList = nodes.filter(n => n.type === 'file');
    const dependencyEdges = edges.filter(e => e.type === 'dependency');
    const navigationEdges = edges.filter(e => e.type === 'navigation');

    // Only show labels when zoomed in enough (zoom > 0.5)
    // Also show label for hovered node regardless of zoom
    const showAllLabels = viewState.zoom > 0.5;
    const showSomeLabels = viewState.zoom > -0.5; // Show important labels at medium zoom
    
    const visiblePluginLabels = pluginNodes.filter((n: Node3D) => {
      // Always show hovered node label
      if (hoveredNode?.id === n.id) return true;
      // Show all labels when zoomed in
      if (showAllLabels) return true;
      // Show labels for important nodes (many dependents) at medium zoom
      if (showSomeLabels && n.dependentCount > 20) return true;
      // Hide labels when zoomed out
      return false;
    });

    return [
      // Dependency edges (grey, thinner) - rendered first (back)
      new ArcLayer({
        id: 'dependency-edges',
        data: dependencyEdges,
        getSourcePosition: (d: Edge3D) => d.source.position,
        getTargetPosition: (d: Edge3D) => d.target.position,
        getSourceColor: [80, 80, 80, 80],
        getTargetColor: [80, 80, 80, 80],
        getWidth: 1,
        greatCircle: false,
        pickable: false,
      }),

      // Navigation edges (blue, animated look)
      new ArcLayer({
        id: 'navigation-edges',
        data: navigationEdges,
        getSourcePosition: (d: Edge3D) => d.source.position,
        getTargetPosition: (d: Edge3D) => d.target.position,
        getSourceColor: [79, 195, 247, 200],
        getTargetColor: [79, 195, 247, 200],
        getWidth: 2,
        greatCircle: false,
        pickable: false,
      }),

      // Plugin nodes - outer glow/stroke for 3D effect
      new ScatterplotLayer({
        id: 'plugin-glow',
        data: pluginNodes,
        getPosition: (d: Node3D) => d.position,
        getFillColor: [0, 0, 0, 0], // Transparent fill
        getLineColor: (d: Node3D) => {
          const [r, g, b] = d.color;
          return [r, g, b, 100]; // Semi-transparent outline
        },
        getRadius: (d: Node3D) => d.radius * 1.3,
        stroked: true,
        lineWidthMinPixels: 2,
        lineWidthMaxPixels: 4,
        radiusMinPixels: 8,
        radiusMaxPixels: 40,
        pickable: false,
      }),

      // Plugin nodes - main circle
      new ScatterplotLayer({
        id: 'plugin-nodes',
        data: pluginNodes,
        getPosition: (d: Node3D) => d.position,
        getFillColor: (d: Node3D) => {
          if (hoveredNode && hoveredNode.id === d.id) {
            return [255, 255, 255, 255];
          }
          return d.color;
        },
        getRadius: (d: Node3D) => d.radius,
        radiusMinPixels: 6,
        radiusMaxPixels: 35,
        pickable: true,
        onClick: handleNodeClick,
        onHover: handleHover,
        updateTriggers: {
          getFillColor: [hoveredNode?.id],
        },
      }),

      // File nodes - outer glow for 3D effect
      new ScatterplotLayer({
        id: 'file-glow',
        data: fileNodesList,
        getPosition: (d: Node3D) => d.position,
        getFillColor: [0, 0, 0, 0],
        getLineColor: [255, 200, 100, 100],
        getRadius: (d: Node3D) => d.radius * 1.5,
        stroked: true,
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 2,
        radiusMinPixels: 4,
        radiusMaxPixels: 12,
        pickable: false,
      }),

      // File nodes - main circle
      new ScatterplotLayer({
        id: 'file-nodes',
        data: fileNodesList,
        getPosition: (d: Node3D) => d.position,
        getFillColor: (d: Node3D) => {
          if (hoveredNode && hoveredNode.id === d.id) {
            return [255, 255, 255, 255];
          }
          return d.color;
        },
        getRadius: (d: Node3D) => d.radius,
        radiusMinPixels: 3,
        radiusMaxPixels: 10,
        pickable: true,
        onClick: handleNodeClick,
        onHover: handleHover,
        updateTriggers: {
          getFillColor: [hoveredNode?.id],
        },
      }),

      // Labels for plugin nodes - rendered LAST (front) so they appear over edges
      // Same X/Y as node, slightly higher Z to appear above
      new TextLayer({
        id: 'plugin-labels',
        data: visiblePluginLabels,
        getPosition: (d: Node3D) => [d.position[0], d.position[1], d.position[2] + 3],
        getText: (d: Node3D) => d.label,
        getSize: 10,
        getColor: (d: Node3D) => {
          if (hoveredNode && hoveredNode.id === d.id) {
            return [255, 255, 255, 255];
          }
          return [220, 220, 220, 255];
        },
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        billboard: true,
        fontFamily: 'Monaco, monospace',
        fontWeight: 'bold',
        outlineWidth: 3,
        outlineColor: [0, 0, 0, 255],
        updateTriggers: {
          getColor: [hoveredNode?.id],
          data: [viewState.zoom, hoveredNode?.id],
        },
      }),

      // Labels for file nodes (only show on hover or when few files AND zoomed in)
      new TextLayer({
        id: 'file-labels',
        data: fileNodesList.filter(
          (n: Node3D) => hoveredNode?.id === n.id || (showAllLabels && fileNodesList.length <= 10)
        ),
        getPosition: (d: Node3D) => [d.position[0], d.position[1], d.position[2] + 2],
        getText: (d: Node3D) => d.label,
        getSize: 8,
        getColor: [255, 200, 100, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        billboard: true,
        fontFamily: 'Monaco, monospace',
        outlineWidth: 2,
        outlineColor: [0, 0, 0, 255],
        updateTriggers: {
          data: [hoveredNode?.id, fileNodesList.length, viewState.zoom],
        },
      }),
    ];
  }, [nodes, edges, hoveredNode, handleNodeClick, handleHover, deckGlReady, viewState.zoom]);

  // Loading state
  if (isLoading) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          color: 'var(--vscode-foreground)',
          opacity: 0.6,
        }}
      >
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🌐</div>
        <div style={{ fontSize: '14px' }}>Initializing 3D view...</div>
        <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.7 }}>
          Loading WebGL components
        </div>
        <div style={{ marginTop: '24px' }}>
          <div
            style={{
              display: 'flex',
              background: 'var(--vscode-editor-background)',
              border: '1px solid var(--vscode-panel-border)',
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            {modes.map((mode) => (
              <button
                key={mode}
                onClick={() => onModeChange(mode)}
                style={{
                  padding: '6px 12px',
                  background: mode === '3d' ? 'var(--vscode-button-background)' : 'transparent',
                  color: mode === '3d' ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontFamily: 'var(--vscode-font-family)',
                  textTransform: 'capitalize',
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          color: 'var(--vscode-foreground)',
        }}
      >
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
        <div style={{ fontSize: '14px', color: 'var(--vscode-errorForeground)' }}>{error}</div>
        <div style={{ marginTop: '24px' }}>
          <button
            onClick={() => onModeChange('complete')}
            style={{
              padding: '8px 16px',
              background: 'var(--vscode-button-background)',
              color: 'var(--vscode-button-foreground)',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Switch to 2D View
          </button>
        </div>
      </div>
    );
  }

  // Empty state
  if (allPlugins.length === 0 || !deckGlReady) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          color: 'var(--vscode-foreground)',
          opacity: 0.6,
        }}
      >
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🌐</div>
        <div style={{ fontSize: '14px' }}>Loading 3D visualization...</div>
        <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.7 }}>
          Plugin data is being fetched
        </div>
      </div>
    );
  }

  const pluginCount = nodes.filter(n => n.type === 'plugin').length;
  const fileCount = nodes.filter(n => n.type === 'file').length;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {DeckGL && OrbitView ? (
        <DeckGL
          views={new OrbitView({ id: 'orbit', orbitAxis: 'Z' })}
          viewState={viewState}
          onViewStateChange={({ viewState: newViewState }: { viewState: typeof viewState }) => {
            setViewState(newViewState);
          }}
          controller={true}
          layers={layers}
          style={{ background: 'var(--vscode-editor-background)' }}
          onError={(err: Error) => {
            setError('WebGL rendering error: ' + err.message);
          }}
        />
      ) : (
        <div style={{ padding: 20, color: 'red' }}>
          DeckGL or OrbitView not loaded!
        </div>
      )}

      {/* Mode toggle and Clear button */}
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
        {/* Clear button */}
        <button
          onClick={onClear}
          style={{
            padding: '6px 12px',
            background: 'var(--vscode-button-secondaryBackground)',
            color: 'var(--vscode-button-secondaryForeground)',
            border: '1px solid var(--vscode-panel-border)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: 'var(--vscode-font-family)',
            transition: 'all 0.15s ease',
          }}
          title="Clear navigation history"
        >
          Clear
        </button>

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
            const isActive = mode === '3d';
            return (
              <button
                key={mode}
                onClick={() => onModeChange(mode)}
                style={{
                  padding: '6px 12px',
                  background: isActive ? 'var(--vscode-button-background)' : 'transparent',
                  color: isActive ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontFamily: 'var(--vscode-font-family)',
                  textTransform: 'capitalize',
                  transition: 'all 0.15s ease',
                }}
                title={`${mode} mode`}
              >
                {mode}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tooltip */}
      {hoveredNode && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            padding: '12px 16px',
            background: 'var(--vscode-editor-background)',
            border: '1px solid var(--vscode-panel-border)',
            borderRadius: '6px',
            color: 'var(--vscode-foreground)',
            fontSize: '12px',
            fontFamily: 'var(--vscode-font-family)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 100,
            maxWidth: '300px',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px', wordBreak: 'break-word' }}>
            {hoveredNode.type === 'file' ? hoveredNode.label : hoveredNode.packageId}
          </div>
          {hoveredNode.type === 'plugin' && (
            <>
              <div style={{ opacity: 0.7, fontSize: '11px' }}>
                Runtime ID: {hoveredNode.runtimeId}
              </div>
              <div style={{ marginTop: '8px', fontSize: '11px' }}>
                <div>Dependencies: {hoveredNode.dependencyCount}</div>
                <div>Dependents: {hoveredNode.dependentCount}</div>
                <div>Depth: {hoveredNode.depth}</div>
              </div>
            </>
          )}
          {hoveredNode.type === 'file' && (
            <div style={{ opacity: 0.7, fontSize: '11px', wordBreak: 'break-all' }}>
              {hoveredNode.packageId}
            </div>
          )}
          <div
            style={{
              marginTop: '8px',
              fontSize: '10px',
              opacity: 0.5,
              borderTop: '1px solid var(--vscode-panel-border)',
              paddingTop: '8px',
            }}
          >
            Click to open {hoveredNode.type}
          </div>
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          bottom: 10,
          left: 10,
          padding: '12px 16px',
          background: 'var(--vscode-editor-background)',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: '6px',
          color: 'var(--vscode-foreground)',
          fontSize: '11px',
          fontFamily: 'var(--vscode-font-family)',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: '8px' }}>Legend</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgb(138, 43, 226), rgb(0, 188, 212))',
            }}
          />
          <span>Plugin (depth: purple→cyan)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: 'rgb(255, 200, 100)',
            }}
          />
          <span>Open file</span>
        </div>
        <div style={{ marginTop: '8px', opacity: 0.7 }}>
          <div>🖱️ Drag to rotate</div>
          <div>⚡ Scroll to zoom</div>
          <div>👆 Click to open</div>
        </div>
      </div>

      {/* Stats */}
      <div
        style={{
          position: 'absolute',
          bottom: 10,
          right: 10,
          padding: '8px 12px',
          background: 'var(--vscode-editor-background)',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: '6px',
          color: 'var(--vscode-foreground)',
          fontSize: '11px',
          fontFamily: 'var(--vscode-font-family)',
          opacity: 0.8,
        }}
      >
        {pluginCount} plugins • {fileCount} files • {edges.length} connections • {maxDepth + 1} levels
      </div>
    </div>
  );
}
