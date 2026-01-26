import * as vscode from 'vscode';
import { StateManager } from './StateManager';
import * as fs from 'fs';
import * as path from 'path';
import {
  FileNode,
  NavigationEdge,
  GroupNode,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  GraphState,
  PluginInfoForWebview,
  SymbolInfo,
  ImportedExport,
} from './types';
import { pluginCache } from './PluginCache';

export class PathfinderViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pathfinder.graphView';

  private _view?: vscode.WebviewView;
  private _pendingMessages: ExtensionToWebviewMessage[] = [];
  private _isReady = false;
  private _loadingPlugins: Map<string, { 
    checkInterval: NodeJS.Timeout | null; 
    failsafeTimeout: NodeJS.Timeout | null;
    uri: vscode.Uri;
  }> = new Map();
  private _navigationTracker?: { handleModeChange: (mode: string) => void };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _stateManager: StateManager
  ) {}

  /**
   * Set the navigation tracker reference (called from extension.ts after NavigationTracker is created)
   */
  public setNavigationTracker(tracker: { handleModeChange: (mode: string) => void }) {
    this._navigationTracker = tracker;
  }

  public dispose() {
    for (const [, data] of this._loadingPlugins) {
      if (data.checkInterval) {
        clearInterval(data.checkInterval);
      }
      if (data.failsafeTimeout) {
        clearTimeout(data.failsafeTimeout);
      }
    }
  }

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

  /**
   * Start tracking TypeScript loading for a plugin.
   * Call this when a file in a new plugin is opened.
   */
  public startTrackingTsLoading(pluginId: string, filePath: string) {
    console.log(`[Kibana Pathfinder] startTrackingTsLoading called: pluginId=${pluginId}, filePath=${filePath}`);
    
    // Don't start tracking if already tracking this plugin
    if (this._loadingPlugins.has(pluginId)) {
      console.log(`[Kibana Pathfinder] Already tracking ${pluginId}, skipping`);
      return;
    }

    const uri = vscode.Uri.file(filePath);
    
    // Send loading started message
    console.log(`[Kibana Pathfinder] Sending tsLoading message: pluginId=${pluginId}, isLoading=true`);
    this._postMessage({ type: 'tsLoading', pluginId, isLoading: true });
    
    // Periodically check if TypeScript is ready by trying to get hover info
    const checkInterval = setInterval(async () => {
      const isReady = await this._checkTsReady(uri);
      console.log(`[Kibana Pathfinder] TypeScript ready check for ${pluginId}: ${isReady}`);
      if (isReady) {
        this._finishTsLoading(pluginId);
      }
    }, 500); // Check every 500ms
    
    // Set a failsafe timeout to auto-clear loading state after 60 seconds
    const failsafeTimeout = setTimeout(() => {
      console.log(`[Kibana Pathfinder] Failsafe timeout reached for ${pluginId}`);
      this._finishTsLoading(pluginId);
    }, 60000);
    
    this._loadingPlugins.set(pluginId, { 
      checkInterval, 
      failsafeTimeout,
      uri,
    });
  }

  /**
   * Check if TypeScript is ready by trying to get type information.
   * Type information (like inferred types in hovers) only works after 
   * the full TypeScript project has been initialized.
   */
  private async _checkTsReady(uri: vscode.Uri): Promise<boolean> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      
      console.log(`[Kibana Pathfinder] _checkTsReady: checking ${uri.fsPath}`);
      
      // Strategy: Find an exported identifier and check if hover returns TYPE information
      // Type inference only works after the full project is loaded
      
      // Look for 'export' statements with identifiers that should have inferred types
      // e.g., "export const plugin" or "export function setup"
      const exportMatch = text.match(/export\s+(?:const|let|function|class)\s+(\w+)/);
      
      if (exportMatch) {
        const identifier = exportMatch[1];
        const identifierIndex = text.indexOf(identifier, text.indexOf(exportMatch[0]));
        const hoverPosition = document.positionAt(identifierIndex);
        
        console.log(`[Kibana Pathfinder] _checkTsReady: checking hover on export '${identifier}' at position ${hoverPosition.line}:${hoverPosition.character}`);
        
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          uri,
          hoverPosition
        );
        
        if (hovers && hovers.length > 0) {
          // Check if the hover contains TypeScript type information
          // Before TS is ready, hover might be empty or just show the identifier
          // After TS is ready, hover will show: "const plugin: PluginInitializerContext => ..."
          for (const hover of hovers) {
            for (const content of hover.contents) {
              const value = typeof content === 'string' ? content : (content as vscode.MarkdownString).value;
              
              console.log(`[Kibana Pathfinder] _checkTsReady: hover content = "${value?.substring(0, 150)}..."`);
              
              // Check for TypeScript type annotations in the hover
              // Look for patterns like ": Type" or "=> Type" which indicate type info
              if (value) {
                // IMPORTANT: Check if TypeScript is still loading
                // The hover will show "(loading...)" while TS is initializing the project
                if (value.includes('(loading...)')) {
                  console.log(`[Kibana Pathfinder] _checkTsReady: TypeScript still loading (found loading indicator)`);
                  return false;
                }
                
                // Must have a typescript code block with actual type annotation
                const hasTypeAnnotation = 
                  value.includes('```typescript') && 
                  (value.includes(': ') || value.includes('=> ') || value.includes('<'));
                
                if (hasTypeAnnotation) {
                  console.log(`[Kibana Pathfinder] TypeScript ready: hover has type annotation`);
                  return true;
                }
              }
            }
          }
        }
        
        console.log(`[Kibana Pathfinder] _checkTsReady: hover did not contain type info`);
      } else {
        console.log(`[Kibana Pathfinder] _checkTsReady: no export found to check`);
      }
      
      // Fallback: check for TypeScript diagnostics with source='ts'
      const diagnostics = vscode.languages.getDiagnostics(uri);
      const tsDiagnostics = diagnostics.filter(d => d.source === 'ts');
      
      console.log(`[Kibana Pathfinder] _checkTsReady: ${diagnostics.length} total diagnostics, ${tsDiagnostics.length} from TS`);
      
      if (tsDiagnostics.length > 0) {
        console.log(`[Kibana Pathfinder] TypeScript ready: found ${tsDiagnostics.length} TS diagnostics`);
        return true;
      }
      
      console.log(`[Kibana Pathfinder] _checkTsReady: NOT ready yet`);
      return false;
    } catch (error) {
      console.log(`[Kibana Pathfinder] TypeScript check error:`, error);
      return false;
    }
  }

  /**
   * Mark a plugin as finished loading TypeScript
   */
  private _finishTsLoading(pluginId: string) {
    const data = this._loadingPlugins.get(pluginId);
    if (data) {
      if (data.checkInterval) {
        clearInterval(data.checkInterval);
      }
      if (data.failsafeTimeout) {
        clearTimeout(data.failsafeTimeout);
      }
      this._loadingPlugins.delete(pluginId);
      this._postMessage({ type: 'tsLoading', pluginId, isLoading: false });
    }
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
        // Close all editors in VS Code
        vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
      case 'openImportSource':
        this._openImportSource(message.importPath, message.symbolName);
        break;
      case 'loadAllPlugins':
        this._loadAllPlugins();
        break;
      case 'requestCodePreview':
        this._handleCodePreviewRequest(message.requestId, message.filePath, message.line, message.contextLines);
        break;
      case 'analyzeImports':
        this._analyzeImportsFromDependency(message.mainPluginId, message.dependencyPluginId);
        break;
      case 'modeChange':
        if (this._navigationTracker) {
          this._navigationTracker.handleModeChange(message.mode);
        }
        break;
    }
  }

  private async _handleCodePreviewRequest(requestId: string, filePath: string, line: number, contextLines: number) {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      
      // Calculate start and end lines (1-based to 0-based conversion)
      const startLine = Math.max(0, line - 1 - contextLines);
      const endLine = Math.min(document.lineCount - 1, line - 1 + contextLines);
      
      const lines: string[] = [];
      for (let i = startLine; i <= endLine; i++) {
        lines.push(document.lineAt(i).text);
      }
      
      this._postMessage({
        type: 'codePreview',
        requestId,
        lines,
        startLine: startLine + 1, // Convert back to 1-based
        highlightLine: line,
      });
    } catch (error) {
      // Send empty response on error
      this._postMessage({
        type: 'codePreview',
        requestId,
        lines: [],
        startLine: line,
        highlightLine: line,
      });
    }
  }

  private async _analyzeImportsFromDependency(mainPluginId: string, dependencyPluginId: string) {
    console.log(`[Kibana Pathfinder] _analyzeImportsFromDependency called`);
    console.log(`[Kibana Pathfinder]   mainPluginId: "${mainPluginId}"`);
    console.log(`[Kibana Pathfinder]   dependencyPluginId: "${dependencyPluginId}"`);
    
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        console.log(`[Kibana Pathfinder] No workspace root found`);
        this._postMessage({ type: 'importAnalysis', dependencyPluginId, imports: [] });
        return;
      }

      // Get the main plugin info to find its directory
      const mainPlugin = pluginCache.getByRuntimeId(mainPluginId);
      if (!mainPlugin) {
        console.log(`[Kibana Pathfinder] Main plugin not found for runtime ID: ${mainPluginId}`);
        this._postMessage({ type: 'importAnalysis', dependencyPluginId, imports: [] });
        return;
      }
      
      console.log(`[Kibana Pathfinder] Main plugin found: ${mainPlugin.packageId} at ${mainPlugin.directory}`);

      // Find all TypeScript/JavaScript files in the main plugin
      const pluginDir = mainPlugin.directory;
      const files = await this._findSourceFiles(pluginDir);
      
      console.log(`[Kibana Pathfinder] Found ${files.length} source files in ${pluginDir}`);
      if (files.length > 0) {
        console.log(`[Kibana Pathfinder] Sample files:`, files.slice(0, 5));
      }

      // Try to get the package ID for the dependency
      // 1. Try by runtime ID
      // 2. Try by package ID (in case the label is the package ID)
      // 3. Try lowercase versions
      // 4. Fall back to using the provided ID directly
      let depPackageId: string;
      
      const byRuntimeId = pluginCache.getByRuntimeId(dependencyPluginId);
      if (byRuntimeId) {
        depPackageId = byRuntimeId.packageId;
      } else {
        const byPackageId = pluginCache.getByPackageId(dependencyPluginId) || 
                           pluginCache.getByPackageId(dependencyPluginId.toLowerCase());
        if (byPackageId) {
          depPackageId = byPackageId.packageId;
        } else {
          // Use the provided ID, normalized to lowercase (Kibana packages are lowercase)
          depPackageId = dependencyPluginId.toLowerCase();
        }
      }
      
      console.log(`[Kibana Pathfinder] Looking for imports from: "${depPackageId}"`);
      
      // Build patterns that match the dependency plugin's package ID
      // Handle both exact match and subpath imports (e.g., '@kbn/plugin/server')
      // Use case-insensitive matching to be safe
      const escapedPackageId = depPackageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      console.log(`[Kibana Pathfinder] Escaped pattern: "${escapedPackageId}"`);
      
      const imports: ImportedExport[] = [];

      for (const filePath of files) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const relativePath = path.relative(pluginDir, filePath);
          
          // Find all import statements that reference the dependency
          // Using a simpler line-by-line approach for reliability
          const lines = content.split('\n');
          
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            // Check if this line imports from the dependency (case-insensitive)
            const fromMatch = line.match(new RegExp(`from\\s+['"]${escapedPackageId}(?:/[^'"]*)?['"]`, 'i'));
            const requireMatch = line.match(new RegExp(`require\\s*\\(\\s*['"]${escapedPackageId}(?:/[^'"]*)?['"]\\s*\\)`, 'i'));
            
            if (!fromMatch && !requireMatch) continue;
            
            // Extract the full import source path (e.g., '@kbn/dashboard-plugin/common')
            const sourcePathMatch = line.match(/from\s+['"]([^'"]+)['"]/);
            const sourcePath = sourcePathMatch ? sourcePathMatch[1] : depPackageId;
            
            console.log(`[Kibana Pathfinder] Found import in ${relativePath}:${lineIdx + 1}: ${line.substring(0, 100)}`);
            
            // Parse named imports: import { foo, bar as baz } from '...'
            // Also handles: import type { foo } from '...'
            const namedMatch = line.match(/import\s+(?:type\s+)?\{([^}]+)\}\s*from/);
            if (namedMatch) {
              const namedImports = namedMatch[1].split(',').map(s => s.trim());
              for (const named of namedImports) {
                if (!named) continue;
                // Handle "type Foo" inside the braces (e.g., import { type Foo } from '...')
                const cleanNamed = named.replace(/^type\s+/, '');
                const aliasMatch = cleanNamed.match(/^(\w+)\s+as\s+(\w+)$/);
                if (aliasMatch) {
                  imports.push({
                    name: aliasMatch[1],
                    alias: aliasMatch[2],
                    isDefault: false,
                    importedIn: relativePath,
                    sourcePath,
                  });
                } else if (cleanNamed) {
                  imports.push({
                    name: cleanNamed,
                    isDefault: false,
                    importedIn: relativePath,
                    sourcePath,
                  });
                }
              }
            }
            
            // Parse default imports: import foo from '...'
            // Also handles: import type foo from '...' (rare but possible)
            const defaultMatch = line.match(/import\s+(?:type\s+)?(\w+)\s+from/);
            if (defaultMatch && !line.includes('{')) {
              imports.push({
                name: 'default',
                alias: defaultMatch[1],
                isDefault: true,
                importedIn: relativePath,
                sourcePath,
              });
            }
            
            // Parse namespace imports: import * as foo from '...'
            const namespaceMatch = line.match(/import\s+\*\s*as\s+(\w+)\s+from/);
            if (namespaceMatch) {
              imports.push({
                name: '*',
                alias: namespaceMatch[1],
                isDefault: false,
                importedIn: relativePath,
                sourcePath,
              });
            }
            
            // Parse combined: import foo, { bar } from '...'
            const combinedMatch = line.match(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from/);
            if (combinedMatch) {
              // Default export
              imports.push({
                name: 'default',
                alias: combinedMatch[1],
                isDefault: true,
                importedIn: relativePath,
                sourcePath,
              });
              // Named exports
              const namedImports = combinedMatch[2].split(',').map(s => s.trim());
              for (const named of namedImports) {
                if (!named) continue;
                const aliasMatch = named.match(/^(\w+)\s+as\s+(\w+)$/);
                if (aliasMatch) {
                  imports.push({
                    name: aliasMatch[1],
                    alias: aliasMatch[2],
                    isDefault: false,
                    importedIn: relativePath,
                    sourcePath,
                  });
                } else {
                  imports.push({
                    name: named,
                    isDefault: false,
                    importedIn: relativePath,
                    sourcePath,
                  });
                }
              }
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }

      console.log(`[Kibana Pathfinder] Total imports found before dedup: ${imports.length}`);
      
      // Deduplicate by name (keep first occurrence)
      const seen = new Map<string, ImportedExport>();
      for (const imp of imports) {
        const key = imp.name + (imp.alias ? `-as-${imp.alias}` : '');
        if (!seen.has(key)) {
          seen.set(key, imp);
        }
      }

      const finalImports = Array.from(seen.values());
      console.log(`[Kibana Pathfinder] Final imports after dedup: ${finalImports.length}`);
      if (finalImports.length > 0) {
        console.log(`[Kibana Pathfinder] Sample imports:`, finalImports.slice(0, 5).map(i => i.name));
      }

      this._postMessage({
        type: 'importAnalysis',
        dependencyPluginId,
        imports: finalImports,
      });
    } catch (error) {
      console.error('[Kibana Pathfinder] Error analyzing imports:', error);
      this._postMessage({ type: 'importAnalysis', dependencyPluginId, imports: [] });
    }
  }

  private async _findSourceFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Skip node_modules and hidden directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'target') {
        continue;
      }
      
      if (entry.isDirectory()) {
        files.push(...await this._findSourceFiles(fullPath));
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    
    return files;
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
          await vscode.window.showTextDocument(doc, { preview: false });
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
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage(`No TypeScript files found in plugin: ${pluginId}`);
      }
    } catch (error) {
      console.error('Error opening plugin index:', error);
      vscode.window.showErrorMessage(`Error opening plugin: ${pluginId}`);
    }
  }

  /**
   * Opens the file where a symbol is defined, following re-exports
   */
  private async _openImportSource(importPath: string, symbolName: string) {
    console.log(`[Kibana Pathfinder] _openImportSource called with importPath="${importPath}", symbolName="${symbolName}"`);
    
    try {
      // Parse the import path to extract package ID and subpath
      // e.g., '@kbn/dashboard-plugin/common' -> packageId: '@kbn/dashboard-plugin', subpath: 'common'
      const match = importPath.match(/^(@[^/]+\/[^/]+)(?:\/(.*))?$/);
      if (!match) {
        console.log(`[Kibana Pathfinder] Invalid import path format`);
        vscode.window.showWarningMessage(`Invalid import path: ${importPath}`);
        return;
      }

      const packageId = match[1];
      const subpath = match[2] || '';
      console.log(`[Kibana Pathfinder] Parsed: packageId="${packageId}", subpath="${subpath}"`);

      // Look up the plugin by package ID
      const pluginInfo = pluginCache.getByPackageId(packageId);
      if (!pluginInfo) {
        console.log(`[Kibana Pathfinder] Plugin not found for packageId: ${packageId}`);
        vscode.window.showWarningMessage(`Could not find plugin for: ${packageId}`);
        return;
      }

      const pluginDir = pluginInfo.directory;
      console.log(`[Kibana Pathfinder] Plugin directory: ${pluginDir}`);
      
      // Try to resolve the subpath to an actual file
      // Common patterns: 'common' -> 'common/index.ts', 'server' -> 'server/index.ts'
      const possiblePaths = [
        `${pluginDir}/${subpath}/index.ts`,
        `${pluginDir}/${subpath}/index.tsx`,
        `${pluginDir}/${subpath}.ts`,
        `${pluginDir}/${subpath}.tsx`,
        `${pluginDir}/${subpath}/index.js`,
        `${pluginDir}/${subpath}.js`,
      ];

      // If no subpath, try the plugin root
      if (!subpath) {
        possiblePaths.unshift(
          `${pluginDir}/index.ts`,
          `${pluginDir}/index.tsx`,
          `${pluginDir}/public/index.ts`,
        );
      }

      let exportFile: vscode.Uri | undefined;
      
      for (const possiblePath of possiblePaths) {
        try {
          const uri = vscode.Uri.file(possiblePath);
          await vscode.workspace.fs.stat(uri);
          exportFile = uri;
          console.log(`[Kibana Pathfinder] Found export file: ${possiblePath}`);
          break;
        } catch {
          // File doesn't exist, try next
        }
      }

      if (!exportFile) {
        console.log(`[Kibana Pathfinder] No exact match, searching...`);
        // If exact resolution failed, search for any matching file
        const searchPattern = new vscode.RelativePattern(pluginDir, subpath ? `${subpath}/**/*.ts` : '**/*.ts');
        const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', 1);
        if (files.length > 0) {
          exportFile = files[0];
          console.log(`[Kibana Pathfinder] Found via search: ${exportFile.fsPath}`);
        }
      }

      if (!exportFile) {
        console.log(`[Kibana Pathfinder] Could not resolve export file`);
        vscode.window.showWarningMessage(`Could not resolve import path: ${importPath}`);
        return;
      }

      // Open the export file first
      const doc = await vscode.workspace.openTextDocument(exportFile);
      
      // Find the symbol in the file to get its position
      const content = doc.getText();
      const symbolRegex = new RegExp(`\\b${symbolName}\\b`);
      const matchResult = content.match(symbolRegex);
      
      console.log(`[Kibana Pathfinder] Searching for symbol "${symbolName}" in file`);
      
      if (matchResult && matchResult.index !== undefined) {
        const position = doc.positionAt(matchResult.index);
        console.log(`[Kibana Pathfinder] Found symbol at position: line ${position.line}, char ${position.character}`);
        
        // Use VS Code's definition provider to find the actual definition
        // The result can be Location[] or LocationLink[] depending on the provider
        const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          'vscode.executeDefinitionProvider',
          exportFile,
          position
        );

        console.log(`[Kibana Pathfinder] Definition provider returned ${definitions?.length || 0} definitions`);

        if (definitions && definitions.length > 0) {
          const def = definitions[0];
          
          // Handle both Location and LocationLink formats
          // LocationLink has targetUri/targetRange, Location has uri/range
          const targetUri = 'targetUri' in def ? def.targetUri : def.uri;
          const targetRange = 'targetSelectionRange' in def ? def.targetSelectionRange : 
                              'targetRange' in def ? def.targetRange : def.range;
          
          console.log(`[Kibana Pathfinder] Opening definition at: ${targetUri.fsPath}`);
          const definitionDoc = await vscode.workspace.openTextDocument(targetUri);
          await vscode.window.showTextDocument(definitionDoc, {
            selection: targetRange,
            preview: false,
          });
          
          // Add the symbol to the file node that will be created
          // Wait for the node to be created by NavigationTracker (give it enough time)
          setTimeout(() => {
            const filePath = targetUri.fsPath;
            const symbolInfo = {
              name: symbolName,
              line: targetRange ? targetRange.start.line + 1 : 1,
              filePath: filePath,
            };
            this._stateManager.addSymbolToNode(filePath, symbolInfo);
            // Send filePath as nodeId - the webview matches by filePath
            this._postMessage({ type: 'addSymbolToNode', nodeId: filePath, symbol: symbolInfo });
          }, 300);
          
          return;
        }
      } else {
        console.log(`[Kibana Pathfinder] Symbol not found in file`);
      }

      // Fallback: just open the export file
      console.log(`[Kibana Pathfinder] Fallback: opening export file`);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      console.error('[Kibana Pathfinder] Error opening import source:', error);
      vscode.window.showErrorMessage(`Error opening import source: ${importPath}`);
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

  public addSymbolToNode(nodeId: string, symbol: SymbolInfo) {
    this._postMessage({ type: 'addSymbolToNode', nodeId, symbol });
  }

  public addSourceSymbolToNode(nodeId: string, symbol: SymbolInfo) {
    this._postMessage({ type: 'addSourceSymbolToNode', nodeId, symbol });
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


