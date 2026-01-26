// Shared types between extension and webview

export type ViewMode = 'journey' | 'plugin' | 'complete' | '3d';

// Symbol information with location for code preview
export interface SymbolInfo {
  name: string;
  line: number; // 1-based line number
  filePath: string;
}

export interface FileNode {
  id: string;
  filePath: string;
  fileName: string;
  relativePath: string;
  pluginName?: string;
  groupId?: string;
  position: { x: number; y: number };
  symbols?: SymbolInfo[]; // Symbols that were followed TO reach this file (destination)
  sourceSymbols?: SymbolInfo[]; // Symbols FROM which navigation originated (source context)
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
  pluginPath?: string; // Path to the plugin directory (e.g., "x-pack/platform/plugins/shared/streams")
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
  | { type: 'addSymbolToNode'; nodeId: string; symbol: SymbolInfo }
  | { type: 'addSourceSymbolToNode'; nodeId: string; symbol: SymbolInfo }
  | { type: 'searchResults'; pluginId: string; results: FileSearchResult[] }
  | { type: 'allPlugins'; plugins: PluginInfoForWebview[] }
  | { type: 'codePreview'; requestId: string; lines: string[]; startLine: number; highlightLine: number }
  | { type: 'importAnalysis'; dependencyPluginId: string; imports: ImportedExport[] }
  | { type: 'tsLoading'; pluginId: string; isLoading: boolean }
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
  | { type: 'openImportSource'; importPath: string; symbolName: string } // Open file where symbol is defined
  | { type: 'loadAllPlugins' }
  | { type: 'requestCodePreview'; requestId: string; filePath: string; line: number; contextLines: number }
  | { type: 'analyzeImports'; mainPluginId: string; dependencyPluginId: string }
  | { type: 'modeChange'; mode: ViewMode } // Notify extension when view mode changes
  | { type: 'ready' };

// File search result
export interface FileSearchResult {
  filePath: string;
  fileName: string;
  relativePath: string;
}

// Import analysis result
export interface ImportedExport {
  name: string; // The export name (or 'default' for default exports)
  alias?: string; // The local alias if renamed (e.g., import { foo as bar })
  isDefault: boolean;
  importedIn: string; // The file in the main plugin that imports this
  sourcePath: string; // The import path (e.g., '@kbn/dashboard-plugin/common')
}


