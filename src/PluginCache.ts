import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface PluginInfo {
  runtimeId: string; // plugin.id like "share"
  packageId: string; // id like "@kbn/share-plugin"
  directory: string; // path to plugin directory
  requiredPlugins: string[]; // dependencies
}

class PluginCacheManager {
  private _cache: Map<string, PluginInfo> = new Map();
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;

  public async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    // Prevent multiple simultaneous initializations
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = this._buildCache();
    await this._initPromise;
    this._initialized = true;
  }

  private async _buildCache(): Promise<void> {
    try {
      // Search for ALL kibana.jsonc files (no limit)
      const kibanaJsonFiles = await vscode.workspace.findFiles('**/kibana.jsonc', '**/node_modules/**');

      console.log(`[Pathfinder] Building plugin cache from ${kibanaJsonFiles.length} kibana.jsonc files`);

      for (const file of kibanaJsonFiles) {
        try {
          const content = fs.readFileSync(file.fsPath, 'utf-8');
          const jsonContent = content
            .replace(/\/\/.*$/gm, '') // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
            .replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas

          const parsed = JSON.parse(jsonContent);
          const runtimeId = parsed.plugin?.id;
          const packageId = parsed.id || '';
          const pluginDir = path.dirname(file.fsPath);
          const requiredPlugins = parsed.plugin?.requiredPlugins || parsed.requiredPlugins || [];

          if (runtimeId) {
            const info: PluginInfo = {
              runtimeId,
              packageId,
              directory: pluginDir,
              requiredPlugins,
            };

            // Store by runtime ID (exact and lowercase)
            this._cache.set(runtimeId, info);
            this._cache.set(runtimeId.toLowerCase(), info);

            // Also store by package ID for reverse lookups
            if (packageId) {
              this._cache.set(packageId, info);
            }
          }
        } catch {
          // Skip files that can't be parsed
        }
      }

      console.log(`[Pathfinder] Plugin cache built with ${this._cache.size} entries`);
    } catch (error) {
      console.error('[Pathfinder] Error building plugin cache:', error);
    }
  }

  public getByRuntimeId(runtimeId: string): PluginInfo | undefined {
    return this._cache.get(runtimeId) || this._cache.get(runtimeId.toLowerCase());
  }

  public getByPackageId(packageId: string): PluginInfo | undefined {
    return this._cache.get(packageId);
  }

  public getDirectory(pluginId: string): string | undefined {
    const info = this.getByRuntimeId(pluginId) || this.getByPackageId(pluginId);
    return info?.directory;
  }

  public getDisplayName(runtimeId: string): string {
    const info = this.getByRuntimeId(runtimeId);
    // Return package ID if available, otherwise return runtime ID
    return info?.packageId || runtimeId;
  }

  public isInitialized(): boolean {
    return this._initialized;
  }

  public clear(): void {
    this._cache.clear();
    this._initialized = false;
    this._initPromise = null;
  }

  /**
   * Get all unique plugins from the cache.
   * Returns an array of PluginInfo objects (deduplicated by runtimeId).
   */
  public getAllPlugins(): PluginInfo[] {
    const seen = new Set<string>();
    const plugins: PluginInfo[] = [];

    for (const info of this._cache.values()) {
      if (!seen.has(info.runtimeId)) {
        seen.add(info.runtimeId);
        plugins.push(info);
      }
    }

    return plugins;
  }
}

// Singleton instance
export const pluginCache = new PluginCacheManager();
