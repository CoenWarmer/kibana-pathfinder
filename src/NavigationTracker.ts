import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PathfinderViewProvider } from './PathfinderViewProvider';
import { StateManager } from './StateManager';
import { FileNode, NavigationEdge, GroupNode } from './types';
import { pluginCache } from './PluginCache';

// Local cache for plugin info (for files not yet in global cache)
interface LocalPluginInfo {
  id: string; // Package ID like "@kbn/share-plugin"
  runtimeId: string; // Runtime ID like "share"
  requiredPlugins?: string[];
  pluginDir: string; // Absolute path to the plugin directory
}
const localPluginInfoCache = new Map<string, LocalPluginInfo | undefined>();

// Clear cache function for debugging/testing
export function clearPluginInfoCache() {
  localPluginInfoCache.clear();
}

// Constants for layout
const GROUP_PADDING = 4; 
const GROUP_HEADER_HEIGHT = 50;
const NODE_WIDTH = 260;
const NODE_HEIGHT = 80;
const NODE_SPACING = 4;

// Symbol tracking info with line number
interface TrackedSymbol {
  name: string;
  line: number;
  filePath: string;
}

export class NavigationTracker implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _previousFilePath: string | undefined;
  private _lastTrackedSymbol: TrackedSymbol | undefined;
  private _lastContainingSymbol: TrackedSymbol | undefined; // The function/class/type containing the cursor
  private _lastSymbolTimestamp: number = 0;

  constructor(
    private readonly _viewProvider: PathfinderViewProvider,
    private readonly _stateManager: StateManager
  ) {
    // Listen to active editor changes
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this._onEditorChange(editor);
      })
    );

    // Listen to document close events
    this._disposables.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        this._onDocumentClose(document);
      })
    );

    // Listen to selection changes to track the word under cursor
    this._disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this._onSelectionChange(event);
      })
    );

    // Listen to tab close events (more reliable than onDidCloseTextDocument)
    this._disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        this._onTabsChange(event);
      })
    );

    // Initialize with current editor if any
    if (vscode.window.activeTextEditor) {
      this._onEditorChange(vscode.window.activeTextEditor);
    }
  }

  /**
   * Handle tab changes - specifically when tabs are closed
   */
  private _onTabsChange(event: vscode.TabChangeEvent) {
    // Handle closed tabs
    for (const tab of event.closed) {
      // Check if it's a text document tab
      if (tab.input instanceof vscode.TabInputText) {
        const filePath = tab.input.uri.fsPath;
        const nodeId = this._generateNodeId(filePath);
        
        // Check if node exists in our state
        const existingState = this._stateManager.getState();
        const node = existingState?.nodes.find((n) => n.id === nodeId);
        
        if (node) {
          const groupId = node.groupId;
          
          // Remove node from state and notify webview
          this._stateManager.deleteNode(nodeId);
          this._viewProvider.removeNode(nodeId);
          
          // Check if group needs resizing
          if (groupId) {
            // Always update group size - this will shrink it back to compact when empty
            this._updateGroupSize(groupId);
          }
        }
      }
    }
  }

  /**
   * Track the word under cursor when selection changes.
   * This helps us capture symbol names when user cmd+clicks to follow a reference.
   */
  private async _onSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
    const editor = event.textEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }

    const selection = event.selections[0];
    if (!selection || !selection.isEmpty) {
      return; // Only track when cursor is at a position (not selecting text)
    }

    // Get the word at the cursor position (the symbol being clicked)
    const wordRange = editor.document.getWordRangeAtPosition(selection.active);
    if (wordRange) {
      const word = editor.document.getText(wordRange);
      // Only track words that look like identifiers (not numbers, keywords, etc.)
      if (word && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(word) && word.length > 1) {
        this._lastTrackedSymbol = {
          name: word,
          line: selection.active.line + 1, // Convert to 1-based
          filePath: editor.document.uri.fsPath,
        };
        this._lastSymbolTimestamp = Date.now();
        
        // Also find the containing function/class/type
        this._lastContainingSymbol = await this._findContainingSymbol(
          editor.document.uri,
          selection.active
        );
      }
    }
  }

  /**
   * Find the function, class, or type that contains the given position.
   */
  private async _findContainingSymbol(
    uri: vscode.Uri,
    position: vscode.Position
  ): Promise<TrackedSymbol | undefined> {
    try {
      // Get document symbols from VS Code
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );

      if (!symbols || symbols.length === 0) {
        return undefined;
      }

      // Find the innermost symbol that contains the position
      const containingSymbol = this._findInnermostContainingSymbol(symbols, position);
      if (containingSymbol) {
        return {
          name: containingSymbol.name,
          line: containingSymbol.selectionRange.start.line + 1, // Convert to 1-based
          filePath: uri.fsPath,
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Find the most meaningful containing symbol for the position.
   * Prioritizes top-level declarations (variables, functions, classes) over nested properties.
   */
  private _findInnermostContainingSymbol(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position
  ): vscode.DocumentSymbol | undefined {
    // Top-level declaration kinds - these are what we want to show as the "source"
    // e.g., "export const processingDissectSuggestionRoute = ..." 
    const topLevelKinds = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Interface,
      vscode.SymbolKind.Variable,
      vscode.SymbolKind.Constant,
      vscode.SymbolKind.Enum,
      vscode.SymbolKind.Constructor,
    ]);

    // Find all symbols that contain the position, tracking the path
    const findContainingPath = (
      syms: vscode.DocumentSymbol[],
      path: vscode.DocumentSymbol[] = []
    ): vscode.DocumentSymbol[] => {
      for (const symbol of syms) {
        if (symbol.range.contains(position)) {
          const newPath = [...path, symbol];
          if (symbol.children && symbol.children.length > 0) {
            const deeperPath = findContainingPath(symbol.children, newPath);
            if (deeperPath.length > newPath.length) {
              return deeperPath;
            }
          }
          return newPath;
        }
      }
      return path;
    };

    const containingPath = findContainingPath(symbols);
    
    if (containingPath.length === 0) {
      return undefined;
    }

    // Find the first (outermost) top-level declaration in the path
    // This gives us "processingDissectSuggestionRoute" instead of "requiredPrivileges"
    for (const symbol of containingPath) {
      if (topLevelKinds.has(symbol.kind)) {
        return symbol;
      }
    }

    // Fallback: return the first symbol in the path
    return containingPath[0];
  }

  private _onEditorChange(editor: vscode.TextEditor | undefined) {
    if (!editor) {
      return;
    }

    const document = editor.document;

    // Skip non-file schemes (e.g., output, git, etc.)
    if (document.uri.scheme !== 'file') {
      return;
    }

    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);

    // Generate a unique ID for the node based on file path
    const nodeId = this._generateNodeId(filePath);

    // Check if this node already exists in state
    const existingState = this._stateManager.getState();
    const existingNode = existingState?.nodes.find((n) => n.id === nodeId);
    const nodeExists = !!existingNode;

    // Check if we have a recent symbol that was tracked (within 500ms)
    // This indicates the user followed a reference (cmd+click)
    const hasRecentSymbol = 
      this._lastTrackedSymbol && 
      this._previousFilePath && 
      this._previousFilePath !== filePath &&
      (Date.now() - this._lastSymbolTimestamp) < 500;
    
    const navigatedSymbol = hasRecentSymbol ? this._lastTrackedSymbol : undefined;

    if (!nodeExists) {
      // Get additional metadata
      const pluginInfo = this._findPluginInfo(filePath);
      const pluginName = pluginInfo?.id;
      // Get path relative to plugin directory (not workspace root)
      const relativePath = this._getRelativePath(filePath, pluginInfo?.pluginDir);

      // Check if we're switching to a new plugin (group doesn't exist yet)
      const groupId = pluginInfo?.runtimeId ? `group-${pluginInfo.runtimeId}` : undefined;
      const existingGroup = groupId ? existingState.groups.find((g) => g.id === groupId) : undefined;
      const isNewPlugin = groupId && (!existingGroup || existingGroup.type === 'dependency');
      
      console.log(`[Kibana Pathfinder] NavigationTracker: groupId=${groupId}, existingGroup=${!!existingGroup}, existingGroup.type=${existingGroup?.type}, isNewPlugin=${isNewPlugin}, pluginName=${pluginName}`);
      
      // Start tracking TypeScript loading for new plugins
      if (isNewPlugin && pluginName) {
        console.log(`[Kibana Pathfinder] NavigationTracker: Calling startTrackingTsLoading for ${pluginName}`);
        this._viewProvider.startTrackingTsLoading(pluginName, filePath);
      }

      // Create or get the group for this node (and required plugin groups)
      const finalGroupId = this._ensureGroup(pluginInfo, existingState);

      // Calculate position for new node within its group
      const position = this._calculateNodePosition(existingState, finalGroupId);

      const newNode: FileNode = {
        id: nodeId,
        filePath,
        fileName,
        relativePath,
        pluginName,
        groupId: finalGroupId,
        position,
        symbols: navigatedSymbol ? [navigatedSymbol] : undefined,
      };

      // Add node to state and notify webview
      this._stateManager.addNode(newNode);
      this._viewProvider.addNode(newNode);

      // Update group size to fit new node
      if (finalGroupId) {
        this._updateGroupSize(finalGroupId);
      }
    } else if (navigatedSymbol && existingNode) {
      // Node exists, but we followed a new symbol to it - add the symbol
      const existingSymbols = existingNode.symbols || [];
      const symbolExists = existingSymbols.some(s => s.name === navigatedSymbol.name && s.line === navigatedSymbol.line);
      if (!symbolExists) {
        this._stateManager.addSymbolToNode(nodeId, navigatedSymbol);
        this._viewProvider.addSymbolToNode(nodeId, navigatedSymbol);
      }
    }

    // Add source symbol to the originating node (the function/class that contained the reference)
    if (hasRecentSymbol && this._lastContainingSymbol && this._previousFilePath) {
      const sourceNodeId = this._generateNodeId(this._previousFilePath);
      const sourceNode = existingState?.nodes.find((n) => n.id === sourceNodeId);
      if (sourceNode) {
        const existingSourceSymbols = sourceNode.sourceSymbols || [];
        const sourceSymbolExists = existingSourceSymbols.some(
          s => s.name === this._lastContainingSymbol!.name && s.line === this._lastContainingSymbol!.line
        );
        if (!sourceSymbolExists) {
          this._stateManager.addSourceSymbolToNode(sourceNodeId, this._lastContainingSymbol);
          this._viewProvider.addSourceSymbolToNode(sourceNodeId, this._lastContainingSymbol);
        }
      }
    }

    // Clear the tracked symbols after using them
    if (hasRecentSymbol) {
      this._lastTrackedSymbol = undefined;
      this._lastContainingSymbol = undefined;
    }

    // Create edge from previous file if exists and different
    if (this._previousFilePath && this._previousFilePath !== filePath) {
      const sourceId = this._generateNodeId(this._previousFilePath);
      const targetId = nodeId;
      const edgeId = `${sourceId}-${targetId}`;
      const reverseEdgeId = `${targetId}-${sourceId}`;

      // Check if edge already exists in either direction
      const edgeExists = existingState?.edges.some(
        (e) => e.id === edgeId || e.id === reverseEdgeId
      );

      if (!edgeExists) {
        const newEdge: NavigationEdge = {
          id: edgeId,
          source: sourceId,
          target: targetId,
        };

        // Add edge to state and notify webview
        this._stateManager.addEdge(newEdge);
        this._viewProvider.addEdge(newEdge);
      }
    }

    // Highlight current node (brief flash) and set as active (persistent)
    this._viewProvider.highlightNode(nodeId);
    this._viewProvider.setActiveNode(nodeId);

    // Update previous file path
    this._previousFilePath = filePath;
  }

  private _onDocumentClose(document: vscode.TextDocument) {
    // Skip non-file schemes
    if (document.uri.scheme !== 'file') {
      return;
    }

    const filePath = document.uri.fsPath;
    const nodeId = this._generateNodeId(filePath);

    // Check if node exists
    const existingState = this._stateManager.getState();
    const node = existingState?.nodes.find((n) => n.id === nodeId);

    if (node) {
      const groupId = node.groupId;

      // Remove node from state and notify webview
      this._stateManager.deleteNode(nodeId);
      this._viewProvider.removeNode(nodeId);

      // Check if group needs resizing or removal
      if (groupId) {
        const remainingNodesInGroup = this._stateManager.getNodesInGroup(groupId);
        if (remainingNodesInGroup.length === 0) {
          // Get the group before potentially deleting/converting it
          const groupToRemove = this._stateManager.getGroup(groupId);
          
          if (groupToRemove) {
            // Extract the runtime ID from the group ID (format: "group-{runtimeId}")
            const runtimeId = groupId.replace('group-', '');
            
            // Check if any other plugin group still requires this as a dependency
            const currentState = this._stateManager.getState();
            const stillRequiredBy = currentState.groups.find(
              (g) =>
                g.type === 'plugin' &&
                g.id !== groupId &&
                g.requiredPlugins?.includes(runtimeId)
            );

            if (stillRequiredBy) {
              // Convert back to a dependency group instead of removing
              const DEP_WIDTH = 100;
              const DEP_HEIGHT = 50;
              
              const convertedGroup: GroupNode = {
                ...groupToRemove,
                type: 'dependency',
                width: DEP_WIDTH,
                height: DEP_HEIGHT,
                requiredPlugins: undefined, // Clear requiredPlugins for dependency groups
              };
              
              this._stateManager.updateGroup(convertedGroup);
              this._viewProvider.updateGroup(convertedGroup);
              
              // Clean up this group's dependency groups since it's no longer a plugin
              if (groupToRemove.requiredPlugins) {
                this._cleanupOrphanedDependencies(groupToRemove.requiredPlugins);
              }
            } else {
              // No other plugin needs this, remove it entirely
              this._stateManager.deleteGroup(groupId);
              this._viewProvider.removeGroup(groupId);

              // Clean up orphaned dependency groups
              if (groupToRemove.requiredPlugins) {
                this._cleanupOrphanedDependencies(groupToRemove.requiredPlugins);
              }
            }
          }
        } else {
          // Group still has nodes, resize it to fit remaining nodes
          this._updateGroupSize(groupId);
        }
      }

      // If this was the previous file, clear it
      if (this._previousFilePath === filePath) {
        this._previousFilePath = undefined;
      }
    }
  }

  private _cleanupOrphanedDependencies(dependencyPluginIds: string[]) {
    const currentState = this._stateManager.getState();

    for (const depPluginId of dependencyPluginIds) {
      const depGroupId = `group-${depPluginId}`;
      const depGroup = currentState.groups.find((g) => g.id === depGroupId);

      if (!depGroup) continue;

      // Check if this dependency group has any nodes
      const nodesInDepGroup = currentState.nodes.filter((n) => n.groupId === depGroupId);
      if (nodesInDepGroup.length > 0) continue; // Has nodes, keep it

      // Check if any other plugin group still requires this dependency
      const stillRequired = currentState.groups.some(
        (g) =>
          g.type === 'plugin' &&
          g.id !== depGroupId &&
          g.requiredPlugins?.includes(depPluginId)
      );

      if (!stillRequired) {
        // No other plugin needs this dependency, remove it
        this._stateManager.deleteGroup(depGroupId);
        this._viewProvider.removeGroup(depGroupId);
      }
    }
  }

  private _generateNodeId(filePath: string): string {
    // Use a hash of the file path for a stable ID
    let hash = 0;
    for (let i = 0; i < filePath.length; i++) {
      const char = filePath.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `node-${Math.abs(hash).toString(16)}`;
  }

  private _getRelativePath(filePath: string, pluginDir?: string): string {
    // If we have a plugin directory, get path relative to it
    if (pluginDir) {
      const relativePath = path.relative(pluginDir, filePath);
      // Return the directory path without the filename
      return path.dirname(relativePath);
    }
    
    // Fallback: Get path relative to workspace root
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
      // Return the directory path without the filename
      return path.dirname(relativePath);
    }
    return path.dirname(filePath);
  }

  private _getPluginPath(pluginDir: string): string {
    // Get the plugin path relative to workspace root
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return path.relative(workspaceFolder.uri.fsPath, pluginDir);
    }
    return pluginDir;
  }

  private _findPluginInfo(filePath: string): LocalPluginInfo | undefined {
    // Get the workspace root as the boundary
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return undefined;
    }

    let currentDir = path.dirname(filePath);

    // Walk up the directory tree, but stay within the workspace
    while (currentDir.startsWith(workspaceRoot) && currentDir.length >= workspaceRoot.length) {
      // Check local cache first
      if (localPluginInfoCache.has(currentDir)) {
        return localPluginInfoCache.get(currentDir);
      }

      const kibanaJsonPath = path.join(currentDir, 'kibana.jsonc');

      if (fs.existsSync(kibanaJsonPath)) {
        try {
          const content = fs.readFileSync(kibanaJsonPath, 'utf-8');
          // Parse JSONC: remove comments and trailing commas
          const jsonContent = content
            .replace(/\/\/.*$/gm, '') // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
            .replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas
          
          const parsed = JSON.parse(jsonContent);
          // requiredPlugins can be at root level or nested in plugin object
          const requiredPlugins = parsed.requiredPlugins || parsed.plugin?.requiredPlugins || [];
          const runtimeId = parsed.plugin?.id || parsed.id; // Runtime ID like "share"
          const pluginInfo: LocalPluginInfo = {
            id: parsed.id, // Package ID like "@kbn/share-plugin"
            runtimeId, // Runtime ID like "share"
            requiredPlugins,
            pluginDir: currentDir, // Store the plugin directory path
          };

          // Cache the result for this directory
          localPluginInfoCache.set(currentDir, pluginInfo);
          return pluginInfo;
        } catch (error) {
          // Failed to parse, cache undefined and continue
          localPluginInfoCache.set(currentDir, undefined);
        }
      }

      // Move up one directory
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached filesystem root
      }
      currentDir = parentDir;
    }

    return undefined;
  }

  private _ensureGroup(
    pluginInfo: LocalPluginInfo | undefined,
    existingState: { nodes: FileNode[]; edges: NavigationEdge[]; groups: GroupNode[] }
  ): string | undefined {
    if (!pluginInfo?.runtimeId) {
      return undefined;
    }

    // Use runtime ID for group ID (so it matches dependency groups)
    const runtimeId = pluginInfo.runtimeId;
    const displayName = pluginInfo.id; // Package ID for display
    const groupId = `group-${runtimeId}`;
    const existingGroup = existingState.groups.find((g) => g.id === groupId);
    const pluginPath = this._getPluginPath(pluginInfo.pluginDir);

    // Check if a dependency group already exists that we need to convert
    if (existingGroup && existingGroup.type === 'dependency') {
      // Convert dependency group to plugin group
      const mainGroupWidth = NODE_WIDTH + GROUP_PADDING * 2;
      const mainGroupHeight = GROUP_HEADER_HEIGHT + NODE_HEIGHT + GROUP_PADDING * 2;
      
      const upgradedGroup: GroupNode = {
        ...existingGroup,
        type: 'plugin',
        width: mainGroupWidth,
        height: mainGroupHeight,
        requiredPlugins: pluginInfo.requiredPlugins || [],
        pluginPath,
      };

      this._stateManager.updateGroup(upgradedGroup);
      this._viewProvider.updateGroup(upgradedGroup);

      // Also create dependency groups for this plugin's dependencies
      const requiredPlugins = pluginInfo.requiredPlugins || [];
      this._createDependencyGroups(requiredPlugins, existingGroup.position, groupId);

      return groupId;
    }

    if (!existingGroup) {
      // Create a brand new plugin group with its dependencies
      const requiredPlugins = pluginInfo.requiredPlugins || [];
      const currentState = this._stateManager.getState();
      
      // Calculate main group size
      const mainGroupWidth = NODE_WIDTH + GROUP_PADDING * 2;
      const mainGroupHeight = GROUP_HEADER_HEIGHT + NODE_HEIGHT + GROUP_PADDING * 2;
      
      // Simple vertical stacking: position new groups below existing ones
      // Find the bottom of all existing plugin groups
      const pluginGroups = currentState.groups.filter(g => g.type === 'plugin');
      const GROUP_GAP = 40; // Gap between groups
      const INITIAL_X = 50; // Starting X position
      const INITIAL_Y = 50; // Starting Y position
      
      let mainGroupX = INITIAL_X;
      let mainGroupY = INITIAL_Y;
      
      if (pluginGroups.length > 0) {
        // Position below the last plugin group
        const lastGroup = pluginGroups[pluginGroups.length - 1];
        mainGroupX = lastGroup.position.x; // Same X as last group
        mainGroupY = lastGroup.position.y + lastGroup.height + GROUP_GAP;
      }
      
      // Create the main plugin group first
      const newGroup: GroupNode = {
        id: groupId,
        label: displayName, // Use package ID as display name
        type: 'plugin',
        position: { x: mainGroupX, y: mainGroupY },
        width: mainGroupWidth,
        height: mainGroupHeight,
        requiredPlugins,
        pluginPath,
      };

      this._stateManager.addGroup(newGroup);
      this._viewProvider.addGroup(newGroup);

      // Create dependency groups around it (for Plugin mode)
      this._createDependencyGroups(requiredPlugins, { x: mainGroupX, y: mainGroupY }, groupId);
    }

    return groupId;
  }

  private _createDependencyGroups(
    requiredPlugins: string[],
    mainGroupPosition: { x: number; y: number },
    mainGroupId: string
  ) {
    const currentState = this._stateManager.getState();
    const mainGroupWidth = NODE_WIDTH + GROUP_PADDING * 2;
    const mainGroupHeight = GROUP_HEADER_HEIGHT + NODE_HEIGHT + GROUP_PADDING * 2;
    
    // Dependency group dimensions for grid layout
    const DEP_WIDTH = 200; // Width of compact dependency group
    const DEP_HEIGHT = 50; // Height of compact dependency group
    const GRID_GAP_X = 20; // Horizontal gap between dependencies
    const GRID_GAP_Y = 15; // Vertical gap between rows
    const GRID_COLUMNS = 5; // Number of columns in the grid
    const GRID_TOP_MARGIN = 40; // Space between main group and dependency grid
    
    // Calculate the starting position for the grid (centered below main group)
    const numDeps = requiredPlugins.length;
    const numRows = Math.ceil(numDeps / GRID_COLUMNS);
    const actualColumns = Math.min(numDeps, GRID_COLUMNS);
    const gridWidth = actualColumns * DEP_WIDTH + (actualColumns - 1) * GRID_GAP_X;
    
    // Center the grid below the main group
    const gridStartX = mainGroupPosition.x + (mainGroupWidth - gridWidth) / 2;
    const gridStartY = mainGroupPosition.y + mainGroupHeight + GRID_TOP_MARGIN;

    requiredPlugins.forEach((depPluginId, index) => {
      const depGroupId = `group-${depPluginId}`;
      const depExists = currentState.groups.some((g) => g.id === depGroupId);
      
      // Calculate grid position
      const row = Math.floor(index / GRID_COLUMNS);
      const col = index % GRID_COLUMNS;
      
      // For the last row, center the items if it's not full
      const itemsInThisRow = row === numRows - 1 ? numDeps - row * GRID_COLUMNS : GRID_COLUMNS;
      const rowOffset = row === numRows - 1 
        ? ((GRID_COLUMNS - itemsInThisRow) * (DEP_WIDTH + GRID_GAP_X)) / 2 
        : 0;
      
      const depX = gridStartX + col * (DEP_WIDTH + GRID_GAP_X) + rowOffset;
      const depY = gridStartY + row * (DEP_HEIGHT + GRID_GAP_Y);
      
      if (!depExists) {
        // Get the display name (package ID) from the plugin cache
        const depDisplayName = pluginCache.getDisplayName(depPluginId);
        
        const depGroup: GroupNode = {
          id: depGroupId,
          label: depDisplayName,
          type: 'dependency',
          position: { x: depX, y: depY },
          width: DEP_WIDTH,
          height: DEP_HEIGHT,
        };

        this._stateManager.addGroup(depGroup);
        this._viewProvider.addGroup(depGroup);
      }

      // Create dependency edge
      const depEdgeId = `dep-${depGroupId}-${mainGroupId}`;
      const edgeExists = this._stateManager.getState().edges.some((e) => e.id === depEdgeId);
      
      if (!edgeExists) {
        // For grid layout, dependencies are below the main group
        // So edges go from dependency's top to main group's bottom
        const depEdge: NavigationEdge = {
          id: depEdgeId,
          source: depGroupId,
          target: mainGroupId,
          sourceHandle: 'top-source',
          targetHandle: 'bottom-target',
          edgeType: 'dependency',
        };
        
        this._stateManager.addEdge(depEdge);
        this._viewProvider.addEdge(depEdge);
      }
    });
  }

  /**
   * Determine which handles to use for an edge based on the angle from center.
   * Angle is in radians, where -PI/2 is top, 0 is right, PI/2 is bottom, ±PI is left.
   */
  private _getHandlesForAngle(angle: number): { 
    sourceHandle: string; 
    targetHandle: string;
  } {
    // Normalize angle to -PI to PI range
    const normalizedAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
    
    // Determine quadrant and return appropriate handles
    // The source (dependency) should connect from the side facing the target (plugin)
    // The target (plugin) should receive on the side facing the source (dependency)
    // Handle IDs now include '-source' or '-target' suffix
    
    if (normalizedAngle >= -Math.PI / 4 && normalizedAngle < Math.PI / 4) {
      // Right side (angle near 0): dependency is to the right of plugin
      return { sourceHandle: 'left-source', targetHandle: 'right-target' };
    } else if (normalizedAngle >= Math.PI / 4 && normalizedAngle < 3 * Math.PI / 4) {
      // Bottom side (angle near PI/2): dependency is below plugin
      return { sourceHandle: 'top-source', targetHandle: 'bottom-target' };
    } else if (normalizedAngle >= -3 * Math.PI / 4 && normalizedAngle < -Math.PI / 4) {
      // Top side (angle near -PI/2): dependency is above plugin
      return { sourceHandle: 'bottom-source', targetHandle: 'top-target' };
    } else {
      // Left side (angle near ±PI): dependency is to the left of plugin
      return { sourceHandle: 'right-source', targetHandle: 'left-target' };
    }
  }

  private _updateGroupSize(groupId: string) {
    const state = this._stateManager.getState();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;

    // Find all nodes in this group
    const nodesInGroup = state.nodes.filter((n) => n.groupId === groupId);
    
    // Calculate required dimensions based on number of nodes
    let requiredHeight: number;
    let requiredWidth: number;
    
    if (nodesInGroup.length === 0) {
      // Empty group - use compact size (matches PathfinderGraph.tsx compact rendering)
      requiredHeight = 50;
      requiredWidth = 200;
    } else {
      // Has nodes - calculate based on node count
      const nodeCount = nodesInGroup.length;
      requiredHeight = GROUP_HEADER_HEIGHT + nodeCount * (NODE_HEIGHT + NODE_SPACING) + GROUP_PADDING;
      requiredWidth = group.width; // Keep existing width
    }

    // Update if dimensions need to change
    if (requiredHeight !== group.height || requiredWidth !== group.width) {
      const updatedGroup: GroupNode = {
        ...group,
        width: requiredWidth,
        height: requiredHeight,
      };
      this._stateManager.updateGroup(updatedGroup);
      this._viewProvider.updateGroup(updatedGroup);
    }
  }

  private _calculateNodePosition(
    existingState: { nodes: FileNode[]; edges: NavigationEdge[]; groups: GroupNode[] },
    groupId: string | undefined
  ): { x: number; y: number } {
    // If node belongs to a group, position within the group
    if (groupId) {
      const nodesInGroup = existingState.nodes.filter((n) => n.groupId === groupId);
      const nodeIndex = nodesInGroup.length;

      // Position relative to group (will be converted in webview)
      return {
        x: GROUP_PADDING,
        y: GROUP_HEADER_HEIGHT + nodeIndex * (NODE_HEIGHT + NODE_SPACING) + GROUP_PADDING,
      };
    }

    // For ungrouped nodes, place below all groups
    const maxGroupBottom = existingState.groups.reduce((max, g) => {
      return Math.max(max, g.position.y + g.height);
    }, 0);

    const ungroupedNodes = existingState.nodes.filter((n) => !n.groupId);
    const nodeIndex = ungroupedNodes.length;

    return {
      x: 20,
      y: maxGroupBottom + 20 + nodeIndex * (NODE_HEIGHT + NODE_SPACING),
    };
  }

  /**
   * Handle view mode changes from the webview.
   * Creates or removes dependency groups based on the new mode.
   */
  public handleModeChange(newMode: string) {
    console.log(`[Kibana Pathfinder] NavigationTracker.handleModeChange: ${newMode}`);
    const currentState = this._stateManager.getState();
    
    if (newMode === 'plugin') {
      // Plugin mode: ensure dependency groups exist for all plugin groups
      const pluginGroups = currentState.groups.filter(g => g.type === 'plugin');
      
      for (const pluginGroup of pluginGroups) {
        const requiredPlugins = pluginGroup.requiredPlugins || [];
        if (requiredPlugins.length > 0) {
          // Check which dependency groups are missing
          const existingGroupIds = new Set(currentState.groups.map(g => g.id));
          const missingDeps = requiredPlugins.filter(dep => !existingGroupIds.has(`group-${dep}`));
          
          if (missingDeps.length > 0) {
            console.log(`[Kibana Pathfinder] Creating ${missingDeps.length} missing dependency groups for ${pluginGroup.label}`);
            this._createDependencyGroups(missingDeps, pluginGroup.position, pluginGroup.id);
          }
        }
      }
    } else if (newMode === 'journey') {
      // Journey mode: remove empty dependency groups
      // Note: Edges are automatically filtered out in the webview based on valid endpoints
      const emptyDependencyGroups = currentState.groups.filter(g => {
        if (g.type !== 'dependency') return false;
        // Check if this group has any file nodes
        const nodesInGroup = currentState.nodes.filter(n => n.groupId === g.id);
        return nodesInGroup.length === 0;
      });
      
      console.log(`[Kibana Pathfinder] Removing ${emptyDependencyGroups.length} empty dependency groups for Journey mode`);
      
      for (const group of emptyDependencyGroups) {
        this._stateManager.deleteGroup(group.id);
        this._viewProvider.removeGroup(group.id);
      }
    }
  }

  public dispose() {
    this._disposables.forEach((d) => d.dispose());
  }
}


