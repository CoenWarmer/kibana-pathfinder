import * as vscode from 'vscode';
import { PathfinderViewProvider } from './PathfinderViewProvider';
import { NavigationTracker } from './NavigationTracker';
import { StateManager } from './StateManager';
import { pluginCache } from './PluginCache';

let navigationTracker: NavigationTracker | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Kibana Pathfinder is now active');

  // Initialize plugin cache (async, but don't block activation)
  pluginCache.initialize().then(() => {
    console.log('[Pathfinder] Plugin cache initialized');
  });

  // Initialize state manager
  const stateManager = new StateManager(context);

  // Create the webview provider
  const provider = new PathfinderViewProvider(context.extensionUri, stateManager);

  // Register the webview view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PathfinderViewProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Initialize navigation tracker
  navigationTracker = new NavigationTracker(provider, stateManager);
  context.subscriptions.push(navigationTracker);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('pathfinder.openPanel', () => {
      // Focus the pathfinder view
      vscode.commands.executeCommand('pathfinder.graphView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pathfinder.clearGraph', () => {
      provider.clearGraph();
      stateManager.clearState();
    })
  );
}

export function deactivate() {
  navigationTracker?.dispose();
}


