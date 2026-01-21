// Shared types between extension and webview

export type ViewMode = 'journey' | 'plugin' | 'complete';

export interface FileNode {
  id: string;
  filePath: string;
  fileName: string;
  relativePath: string;
  pluginName?: string;
  groupId?: string;
  position: { x: number; y: number };
}

export interface GroupNode {
  id: string;
  label: string;
  type: 'plugin' | 'path' | 'dependency';
  parentId?: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  requiredPlugins?: string[]; // For plugin groups, tracks their dependencies
}

export interface NavigationEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  edgeType?: 'navigation' | 'dependency'; // 'navigation' for file-to-file, 'dependency' for group-to-group
}

export interface GraphState {
  nodes: FileNode[];
  edges: NavigationEdge[];
  groups: GroupNode[];
  viewMode?: ViewMode;
}

// Plugin info for complete mode
export interface PluginInfoForWebview {
  runtimeId: string;
  packageId: string;
  requiredPlugins: string[];
}

// Messages from Extension to Webview
export type ExtensionToWebviewMessage =
  | { type: 'addNode'; node: FileNode }
  | { type: 'addEdge'; edge: NavigationEdge }
  | { type: 'addGroup'; group: GroupNode }
  | { type: 'updateGroup'; group: GroupNode }
  | { type: 'removeGroup'; groupId: string }
  | { type: 'loadState'; state: GraphState }
  | { type: 'highlightNode'; nodeId: string }
  | { type: 'setActiveNode'; nodeId: string | null }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'searchResults'; pluginId: string; results: FileSearchResult[] }
  | { type: 'allPlugins'; plugins: PluginInfoForWebview[] }
  | { type: 'clear' };

// Messages from Webview to Extension
export type WebviewToExtensionMessage =
  | { type: 'openFile'; filePath: string }
  | { type: 'closeFile'; filePath: string }
  | { type: 'deleteNode'; nodeId: string }
  | { type: 'clearGraph' }
  | { type: 'saveState'; state: GraphState }
  | { type: 'searchFiles'; pluginId: string; query: string }
  | { type: 'openPluginIndex'; pluginId: string }
  | { type: 'loadAllPlugins' }
  | { type: 'ready' };

// File search result
export interface FileSearchResult {
  filePath: string;
  fileName: string;
  relativePath: string;
}


