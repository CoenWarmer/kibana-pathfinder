import React, { useEffect, useState, useCallback } from 'react';
import { PathfinderGraph } from './components/PathfinderGraph';
import {
  FileNode,
  NavigationEdge,
  GroupNode,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  FileSearchResult,
  ViewMode,
  PluginInfoForWebview,
} from '../types';

// Acquire VS Code API
const vscode = acquireVsCodeApi();

function App() {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [edges, setEdges] = useState<NavigationEdge[]>([]);
  const [groups, setGroups] = useState<GroupNode[]>([]);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<{ [pluginId: string]: FileSearchResult[] }>({});
  const [viewMode, setViewMode] = useState<ViewMode>('journey');
  const [allPlugins, setAllPlugins] = useState<PluginInfoForWebview[]>([]);

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
            setViewMode(message.state.viewMode);
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

        case 'clear':
          setNodes([]);
          setEdges([]);
          setGroups([]);
          setSearchResults({});
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

  const handleStateChange = useCallback(
    (newNodes: FileNode[], newEdges: NavigationEdge[]) => {
      setNodes(newNodes);
      setEdges(newEdges);
      postMessage({ type: 'saveState', state: { nodes: newNodes, edges: newEdges, groups, viewMode } });
    },
    [postMessage, groups, viewMode]
  );

  const handleGroupsChange = useCallback(
    (newGroups: GroupNode[]) => {
      setGroups(newGroups);
      postMessage({ type: 'saveState', state: { nodes, edges, groups: newGroups, viewMode } });
    },
    [postMessage, nodes, edges, viewMode]
  );

  const handleModeChange = useCallback(
    (newMode: ViewMode) => {
      setViewMode(newMode);
      postMessage({ type: 'saveState', state: { nodes, edges, groups, viewMode: newMode } });
    },
    [postMessage, nodes, edges, groups]
  );

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <PathfinderGraph
        nodes={nodes}
        edges={edges}
        groups={groups}
        highlightedNodeId={highlightedNodeId}
        activeNodeId={activeNodeId}
        searchResults={searchResults}
        viewMode={viewMode}
        allPlugins={allPlugins}
        onNodeClick={handleNodeClick}
        onNodeDelete={handleNodeDelete}
        onClear={handleClear}
        onStateChange={handleStateChange}
        onGroupsChange={handleGroupsChange}
        onSearchFiles={handleSearchFiles}
        onOpenPluginIndex={handleOpenPluginIndex}
        onModeChange={handleModeChange}
      />
    </div>
  );
}

export default App;
