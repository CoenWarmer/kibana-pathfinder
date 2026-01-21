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
}
const localPluginInfoCache = new Map<string, LocalPluginInfo | undefined>();

// Clear cache function for debugging/testing
export function clearPluginInfoCache() {
  localPluginInfoCache.clear();
}

// Constants for layout
const GROUP_PADDING = 20;
const GROUP_HEADER_HEIGHT = 40;
const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const NODE_SPACING = 20;

export class NavigationTracker implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _previousFilePath: string | undefined;

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

    // Initialize with current editor if any
    if (vscode.window.activeTextEditor) {
      this._onEditorChange(vscode.window.activeTextEditor);
    }
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
    const nodeExists = existingState?.nodes.some((n) => n.id === nodeId);

    if (!nodeExists) {
      // Get additional metadata
      const pluginInfo = this._findPluginInfo(filePath);
      const pluginName = pluginInfo?.id;
      const relativePath = this._getRelativePath(filePath);

      // Create or get the group for this node (and required plugin groups)
      const groupId = this._ensureGroup(pluginInfo, relativePath, existingState);

      // Calculate position for new node within its group
      const position = this._calculateNodePosition(existingState, groupId);

      const newNode: FileNode = {
        id: nodeId,
        filePath,
        fileName,
        relativePath,
        pluginName,
        groupId,
        position,
      };

      // Add node to state and notify webview
      this._stateManager.addNode(newNode);
      this._viewProvider.addNode(newNode);

      // Update group size to fit new node
      if (groupId) {
        this._updateGroupSize(groupId);
      }
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

      // Check if group is now empty
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

  private _getRelativePath(filePath: string): string {
    // Get path relative to workspace root
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
      // Return the directory path without the filename
      return path.dirname(relativePath);
    }
    return path.dirname(filePath);
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
    relativePath: string,
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
      
      // Calculate main group position and size
      const pluginGroupCount = currentState.groups.filter(g => g.type === 'plugin').length;
      const mainGroupWidth = NODE_WIDTH + GROUP_PADDING * 2;
      const mainGroupHeight = GROUP_HEADER_HEIGHT + NODE_HEIGHT + GROUP_PADDING * 2;
      
      // Dependency group dimensions
      const DEP_WIDTH = 400;
      const DEP_HEIGHT = 50;
      const DEP_GAP = 5; // Minimum gap between dependency groups
      
      // Calculate dynamic radius based on number of dependencies
      const numDeps = requiredPlugins.length;
      const minRadius = Math.max(200, (numDeps * (DEP_WIDTH + DEP_GAP)) / (2 * Math.PI));
      const CIRCLE_RADIUS = minRadius + mainGroupWidth / 2 + 30;
      
      // Main group center position
      const mainGroupCenterX = CIRCLE_RADIUS + DEP_WIDTH / 2 + 50;
      const mainGroupCenterY = CIRCLE_RADIUS + DEP_HEIGHT / 2 + 50 + pluginGroupCount * (CIRCLE_RADIUS * 2 + 150);
      
      // Main group top-left position
      const mainGroupX = mainGroupCenterX - mainGroupWidth / 2;
      const mainGroupY = mainGroupCenterY - mainGroupHeight / 2;
      
      // Create the main plugin group first
      const newGroup: GroupNode = {
        id: groupId,
        label: displayName, // Use package ID as display name
        type: 'plugin',
        position: { x: mainGroupX, y: mainGroupY },
        width: mainGroupWidth,
        height: mainGroupHeight,
        requiredPlugins,
      };

      this._stateManager.addGroup(newGroup);
      this._viewProvider.addGroup(newGroup);

      // Create dependency groups around it
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
    
    // Dependency group dimensions
    const DEP_WIDTH = 100;
    const DEP_HEIGHT = 50;
    const DEP_GAP = 5;
    
    // Calculate center of main group
    const mainGroupCenterX = mainGroupPosition.x + mainGroupWidth / 2;
    const mainGroupCenterY = mainGroupPosition.y + mainGroupHeight / 2;
    
    // Calculate dynamic radius
    const numDeps = requiredPlugins.length;
    const minRadius = Math.max(200, (numDeps * (DEP_WIDTH + DEP_GAP)) / (2 * Math.PI));
    const CIRCLE_RADIUS = minRadius + mainGroupWidth / 2 + 30;

    requiredPlugins.forEach((depPluginId, index) => {
      const depGroupId = `group-${depPluginId}`;
      const depExists = currentState.groups.some((g) => g.id === depGroupId);
      
      // Calculate angle for this dependency (used for positioning and handle selection)
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / numDeps;
      
      if (!depExists) {
        // Calculate center position on the circle
        const depCenterX = mainGroupCenterX + Math.cos(angle) * CIRCLE_RADIUS;
        const depCenterY = mainGroupCenterY + Math.sin(angle) * CIRCLE_RADIUS;
        
        // Convert to top-left position
        const depX = depCenterX - DEP_WIDTH / 2;
        const depY = depCenterY - DEP_HEIGHT / 2;
        
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

      // Create dependency edge with appropriate handles based on angle
      const depEdgeId = `dep-${depGroupId}-${mainGroupId}`;
      const edgeExists = this._stateManager.getState().edges.some((e) => e.id === depEdgeId);
      
      if (!edgeExists) {
        // Determine which handles to use based on the angle
        // The dependency is positioned at 'angle' from the center of the main group
        // We want the edge to connect on the facing sides
        const { sourceHandle, targetHandle } = this._getHandlesForAngle(angle);
        
        const depEdge: NavigationEdge = {
          id: depEdgeId,
          source: depGroupId,
          target: mainGroupId,
          sourceHandle,
          targetHandle,
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
    if (nodesInGroup.length === 0) return;

    // Calculate required height
    const requiredHeight =
      GROUP_HEADER_HEIGHT + nodesInGroup.length * (NODE_HEIGHT + NODE_SPACING) + GROUP_PADDING;

    if (requiredHeight > group.height) {
      const updatedGroup: GroupNode = {
        ...group,
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

  public dispose() {
    this._disposables.forEach((d) => d.dispose());
  }
}


