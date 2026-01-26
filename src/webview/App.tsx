import React, { useEffect, useState, useCallback } from 'react';
import { PathfinderGraph } from './components/PathfinderGraph';
import { PathfinderGraph3D } from './components/PathfinderGraph3D';
import {
  FileNode,
  NavigationEdge,
  GroupNode,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  FileSearchResult,
  ViewMode,
  PluginInfoForWebview,
  ImportedExport,
} from '../types';

// Import shared VS Code API instance
import { vscode } from './vscodeApi';

function App() {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [edges, setEdges] = useState<NavigationEdge[]>([]);
  const [groups, setGroups] = useState<GroupNode[]>([]);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<{ [pluginId: string]: FileSearchResult[] }>({});
  const [viewMode, setViewMode] = useState<ViewMode>('journey');
  const [allPlugins, setAllPlugins] = useState<PluginInfoForWebview[]>([]);
  const [importAnalysis, setImportAnalysis] = useState<{ [dependencyPluginId: string]: ImportedExport[] }>({});
  const [analyzingImports, setAnalyzingImports] = useState<string | null>(null);
  const [openImportAnalysisPopup, setOpenImportAnalysisPopup] = useState<string | null>(null);
  const [loadingPlugins, setLoadingPlugins] = useState<Set<string>>(new Set());

  // Send message to extension
  const postMessage = useCallback((message: WebviewToExtensionMessage) => {
    vscode.postMessage(message);
  }, []);

  // Handle messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;

      switch (message.type) {
        case 'addNode':
          setNodes((prev) => {
            if (prev.some((n) => n.id === message.node.id)) {
              return prev;
            }
            return [...prev, message.node];
          });
          break;

        case 'addEdge':
          setEdges((prev) => {
            if (prev.some((e) => e.id === message.edge.id)) {
              return prev;
            }
            return [...prev, message.edge];
          });
          break;

        case 'addGroup':
          setGroups((prev) => {
            if (prev.some((g) => g.id === message.group.id)) {
              return prev;
            }
            return [...prev, message.group];
          });
          break;

        case 'updateGroup':
          setGroups((prev) =>
            prev.map((g) => {
              if (g.id === message.group.id) {
                // Preserve the existing position (important for Complete mode force-layout)
                return {
                  ...message.group,
                  position: g.position,
                };
              }
              return g;
            })
          );
          break;

        case 'loadState':
          setNodes(message.state.nodes);
          setEdges(message.state.edges);
          setGroups(message.state.groups || []);
          if (message.state.viewMode) {
            // Don't restore '3d' mode - it's experimental and slow
            setViewMode(message.state.viewMode === '3d' ? 'journey' : message.state.viewMode);
          }
          break;

        case 'highlightNode':
          setHighlightedNodeId(message.nodeId);
          setTimeout(() => setHighlightedNodeId(null), 2000);
          break;

        case 'setActiveNode':
          setActiveNodeId(message.nodeId);
          break;

        case 'removeNode':
          setNodes((prev) => prev.filter((n) => n.id !== message.nodeId));
          setEdges((prev) =>
            prev.filter((e) => e.source !== message.nodeId && e.target !== message.nodeId)
          );
          break;

        case 'addSymbolToNode':
          setNodes((prev) =>
            prev.map((n) => {
              // Match by filePath since nodeId uses a hash
              if (n.filePath === message.nodeId || n.id === message.nodeId) {
                const existingSymbols = n.symbols || [];
                const exists = existingSymbols.some(
                  (s) => s.name === message.symbol.name && s.line === message.symbol.line
                );
                if (!exists) {
                  return { ...n, symbols: [...existingSymbols, message.symbol] };
                }
              }
              return n;
            })
          );
          break;

        case 'addSourceSymbolToNode':
          setNodes((prev) =>
            prev.map((n) => {
              if (n.id === message.nodeId) {
                const existingSourceSymbols = n.sourceSymbols || [];
                const exists = existingSourceSymbols.some(
                  (s) => s.name === message.symbol.name && s.line === message.symbol.line
                );
                if (!exists) {
                  return { ...n, sourceSymbols: [...existingSourceSymbols, message.symbol] };
                }
              }
              return n;
            })
          );
          break;

        case 'removeGroup':
          setGroups((prev) => prev.filter((g) => g.id !== message.groupId));
          break;

        case 'searchResults':
          setSearchResults((prev) => ({
            ...prev,
            [message.pluginId]: message.results,
          }));
          break;

        case 'allPlugins':
          setAllPlugins(message.plugins);
          break;

        case 'importAnalysis':
          setImportAnalysis((prev) => ({
            ...prev,
            [message.dependencyPluginId]: message.imports,
          }));
          setAnalyzingImports(null);
          break;

        case 'tsLoading':
          setLoadingPlugins((prev) => {
            const next = new Set(prev);
            if (message.isLoading) {
              next.add(message.pluginId);
            } else {
              next.delete(message.pluginId);
            }
            return next;
          });
          break;

        case 'clear':
          setNodes([]);
          setEdges([]);
          setGroups([]);
          setSearchResults({});
          setImportAnalysis({});
          setLoadingPlugins(new Set());
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'ready' });
    
    // Always request all plugins on startup for complete mode
    postMessage({ type: 'loadAllPlugins' });

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [postMessage]);

  const handleNodeClick = useCallback(
    (filePath: string) => {
      postMessage({ type: 'openFile', filePath });
    },
    [postMessage]
  );

  const handleNodeDelete = useCallback(
    (nodeId: string, filePath: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
      postMessage({ type: 'deleteNode', nodeId });
      postMessage({ type: 'closeFile', filePath });
    },
    [postMessage]
  );

  const handleAnalyzeImports = useCallback(
    (mainPluginId: string, dependencyPluginId: string) => {
      setAnalyzingImports(dependencyPluginId);
      postMessage({ type: 'analyzeImports', mainPluginId, dependencyPluginId });
    },
    [postMessage]
  );

  const handleOpenImportSource = useCallback(
    (importPath: string, symbolName: string) => {
      // Close the popup when opening a file from it
      setOpenImportAnalysisPopup(null);
      postMessage({ type: 'openImportSource', importPath, symbolName });
    },
    [postMessage]
  );

  const handleClear = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setGroups([]);
    setSearchResults({});
    postMessage({ type: 'clearGraph' });
  }, [postMessage]);

  const handleSearchFiles = useCallback(
    (pluginId: string, query: string) => {
      postMessage({ type: 'searchFiles', pluginId, query });
    },
    [postMessage]
  );

  const handleOpenPluginIndex = useCallback(
    (pluginId: string) => {
      postMessage({ type: 'openPluginIndex', pluginId });
    },
    [postMessage]
  );

  // Helper to get persistable view mode (don't persist '3d' mode - it's experimental)
  const getPersistableViewMode = (mode: ViewMode): ViewMode => (mode === '3d' ? 'journey' : mode);

  const handleStateChange = useCallback(
    (newNodes: FileNode[], newEdges: NavigationEdge[]) => {
      setNodes(newNodes);
      setEdges(newEdges);
      postMessage({ type: 'saveState', state: { nodes: newNodes, edges: newEdges, groups, viewMode: getPersistableViewMode(viewMode) } });
    },
    [postMessage, groups, viewMode]
  );

  const handleGroupsChange = useCallback(
    (newGroups: GroupNode[]) => {
      setGroups(newGroups);
      postMessage({ type: 'saveState', state: { nodes, edges, groups: newGroups, viewMode: getPersistableViewMode(viewMode) } });
    },
    [postMessage, nodes, edges, viewMode]
  );

  const handleModeChange = useCallback(
    (newMode: ViewMode) => {
      setViewMode(newMode);
      // Don't persist '3d' mode - it's experimental and slow
      postMessage({ type: 'saveState', state: { nodes, edges, groups, viewMode: getPersistableViewMode(newMode) } });
      // Notify extension about mode change to update groups/edges
      postMessage({ type: 'modeChange', mode: newMode });
    },
    [postMessage, nodes, edges, groups]
  );

  return (
    <div style={{ width: '100%', height: '100%' }}>
      {viewMode === '3d' ? (
        <PathfinderGraph3D
          allPlugins={allPlugins}
          fileNodes={nodes}
          fileEdges={edges}
          groups={groups}
          activeNodeId={activeNodeId}
          onPluginClick={handleOpenPluginIndex}
          onPluginDoubleClick={handleOpenPluginIndex}
          onFileClick={handleNodeClick}
          onModeChange={handleModeChange}
          onClear={handleClear}
        />
      ) : (
        <PathfinderGraph
          nodes={nodes}
          edges={edges}
          groups={groups}
          highlightedNodeId={highlightedNodeId}
          activeNodeId={activeNodeId}
          searchResults={searchResults}
          viewMode={viewMode}
          allPlugins={allPlugins}
          importAnalysis={importAnalysis}
          analyzingImports={analyzingImports}
          openImportAnalysisPopup={openImportAnalysisPopup}
          loadingPlugins={loadingPlugins}
          onNodeClick={handleNodeClick}
          onNodeDelete={handleNodeDelete}
          onClear={handleClear}
          onStateChange={handleStateChange}
          onGroupsChange={handleGroupsChange}
          onSearchFiles={handleSearchFiles}
          onOpenPluginIndex={handleOpenPluginIndex}
          onModeChange={handleModeChange}
          onAnalyzeImports={handleAnalyzeImports}
          onToggleImportAnalysis={setOpenImportAnalysisPopup}
          onOpenImportSource={handleOpenImportSource}
        />
      )}
    </div>
  );
}

export default App;
