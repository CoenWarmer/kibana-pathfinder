import * as vscode from 'vscode';
import { StateManager } from './StateManager';
import {
  FileNode,
  NavigationEdge,
  GroupNode,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  GraphState,
  PluginInfoForWebview,
} from './types';
import { pluginCache } from './PluginCache';

export class PathfinderViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pathfinder.graphView';

  private _view?: vscode.WebviewView;
  private _pendingMessages: ExtensionToWebviewMessage[] = [];
  private _isReady = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _stateManager: StateManager
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._isReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      this._handleMessage(message);
    });

    // When view becomes visible, load state
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this._isReady) {
        this._loadSavedState();
      }
    });
  }

  private _handleMessage(message: WebviewToExtensionMessage) {
    switch (message.type) {
      case 'ready':
        this._isReady = true;
        // Send any pending messages
        this._pendingMessages.forEach((msg) => this._postMessage(msg));
        this._pendingMessages = [];
        // Load saved state
        this._loadSavedState();
        break;
      case 'openFile':
        this._openFile(message.filePath);
        break;
      case 'closeFile':
        this._closeFile(message.filePath);
        break;
      case 'deleteNode':
        // Get the node's group before deleting
        const state = this._stateManager.getState();
        const nodeToDelete = state.nodes.find((n) => n.id === message.nodeId);
        const groupId = nodeToDelete?.groupId;

        // Delete the node
        this._stateManager.deleteNode(message.nodeId);

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
                this.updateGroup(convertedGroup);
                
                // Clean up this group's dependency groups since it's no longer a plugin
                if (groupToRemove.requiredPlugins) {
                  this._cleanupOrphanedDependencies(groupToRemove.requiredPlugins);
                }
              } else {
                // No other plugin needs this, remove it entirely
                this._stateManager.deleteGroup(groupId);
                this.removeGroup(groupId);

                // Clean up orphaned dependency groups
                if (groupToRemove.requiredPlugins) {
                  this._cleanupOrphanedDependencies(groupToRemove.requiredPlugins);
                }
              }
            }
          }
        }
        break;
      case 'clearGraph':
        this._stateManager.clearState();
        break;
      case 'saveState':
        this._stateManager.saveState(message.state);
        break;
      case 'searchFiles':
        this._searchFiles(message.pluginId, message.query);
        break;
      case 'openPluginIndex':
        this._openPluginIndex(message.pluginId);
        break;
      case 'loadAllPlugins':
        this._loadAllPlugins();
        break;
    }
  }

  private async _openFile(filePath: string) {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preserveFocus: false,
        preview: false,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  private async _closeFile(filePath: string) {
    try {
      const uri = vscode.Uri.file(filePath);
      // Find the tab with this file and close it
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => {
          const tabInput = tab.input;
          if (tabInput && typeof tabInput === 'object' && 'uri' in tabInput) {
            return (tabInput as { uri: vscode.Uri }).uri.fsPath === uri.fsPath;
          }
          return false;
        });

      for (const tab of tabs) {
        await vscode.window.tabGroups.close(tab);
      }
    } catch (error) {
      // Silently fail if file can't be closed
      console.error(`Could not close file: ${filePath}`, error);
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
        this.removeGroup(depGroupId);
      }
    }
  }

  private _loadSavedState() {
    const state = this._stateManager.getState();
    if (state && (state.nodes.length > 0 || state.edges.length > 0)) {
      this._postMessage({ type: 'loadState', state });
    }
  }

  private async _searchFiles(pluginId: string, query: string) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this._postMessage({ type: 'searchResults', pluginId, results: [] });
        return;
      }

      // Find the plugin's directory using the shared cache
      const pluginDir = await this._findPluginDirectory(pluginId);
      
      if (!pluginDir) {
        this._postMessage({ type: 'searchResults', pluginId, results: [] });
        return;
      }

      // Search for files matching the query within the plugin directory
      const searchPattern = new vscode.RelativePattern(pluginDir, `**/*${query}*`);
      const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', 50);

      const results: { filePath: string; fileName: string; relativePath: string }[] = [];
      
      for (const file of files) {
        const filePath = file.fsPath;
        const fileName = filePath.split('/').pop() || filePath;
        const relativePath = vscode.workspace.asRelativePath(filePath);
        results.push({ filePath, fileName, relativePath });
        
        // Limit results
        if (results.length >= 20) break;
      }

      this._postMessage({ type: 'searchResults', pluginId, results });
    } catch (error) {
      console.error('Error searching files:', error);
      this._postMessage({ type: 'searchResults', pluginId, results: [] });
    }
  }

  private async _findPluginDirectory(pluginId: string): Promise<string | undefined> {
    // Ensure plugin cache is initialized
    await pluginCache.initialize();

    // Use shared plugin cache
    return pluginCache.getDirectory(pluginId);
  }

  private async _openPluginIndex(pluginId: string) {
    try {
      const pluginDir = await this._findPluginDirectory(pluginId);
      
      if (!pluginDir) {
        vscode.window.showWarningMessage(`Could not find plugin directory for: ${pluginId}`);
        return;
      }

      // Common index file patterns to look for
      const indexPatterns = [
        'public/index.ts',
        'public/index.tsx',
        'index.ts',
        'index.tsx',
        'server/index.ts',
        'common/index.ts',
      ];

      // Try each pattern
      for (const pattern of indexPatterns) {
        const indexPath = vscode.Uri.file(`${pluginDir}/${pattern}`);
        try {
          await vscode.workspace.fs.stat(indexPath);
          // File exists, open it
          const doc = await vscode.workspace.openTextDocument(indexPath);
          await vscode.window.showTextDocument(doc);
          return;
        } catch {
          // File doesn't exist, try next pattern
        }
      }

      // If no index file found, try to find any TypeScript file in the plugin
      const searchPattern = new vscode.RelativePattern(pluginDir, '**/*.ts');
      const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', 1);
      
      if (files.length > 0) {
        const doc = await vscode.workspace.openTextDocument(files[0]);
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showWarningMessage(`No TypeScript files found in plugin: ${pluginId}`);
      }
    } catch (error) {
      console.error('Error opening plugin index:', error);
      vscode.window.showErrorMessage(`Error opening plugin: ${pluginId}`);
    }
  }

  private async _loadAllPlugins() {
    // Ensure plugin cache is initialized
    await pluginCache.initialize();

    // Get all plugins from the cache
    const allPlugins = pluginCache.getAllPlugins();

    // Map to the webview format
    const plugins: PluginInfoForWebview[] = allPlugins.map((p) => ({
      runtimeId: p.runtimeId,
      packageId: p.packageId,
      requiredPlugins: p.requiredPlugins,
    }));

    this._postMessage({ type: 'allPlugins', plugins });
  }

  private _postMessage(message: ExtensionToWebviewMessage) {
    if (this._view && this._isReady) {
      this._view.webview.postMessage(message);
    } else {
      this._pendingMessages.push(message);
    }
  }

  public addNode(node: FileNode) {
    this._postMessage({ type: 'addNode', node });
  }

  public addEdge(edge: NavigationEdge) {
    this._postMessage({ type: 'addEdge', edge });
  }

  public addGroup(group: GroupNode) {
    this._postMessage({ type: 'addGroup', group });
  }

  public updateGroup(group: GroupNode) {
    this._postMessage({ type: 'updateGroup', group });
  }

  public removeGroup(groupId: string) {
    this._postMessage({ type: 'removeGroup', groupId });
  }

  public highlightNode(nodeId: string) {
    this._postMessage({ type: 'highlightNode', nodeId });
  }

  public setActiveNode(nodeId: string | null) {
    this._postMessage({ type: 'setActiveNode', nodeId });
  }

  public clearGraph() {
    this._postMessage({ type: 'clear' });
  }

  public removeNode(nodeId: string) {
    this._postMessage({ type: 'removeNode', nodeId });
  }

  public updateState(state: GraphState) {
    this._postMessage({ type: 'loadState', state });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    
    const workerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'forceLayoutWorker.js')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' blob:; worker-src ${webview.cspSource} blob:;">
    <title>Pathfinder</title>
    <style>
      html, body, #root {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
      }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">
      window.forceLayoutWorkerUrl = "${workerUri}";
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}


