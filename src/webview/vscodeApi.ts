// Shared VS Code API instance
// acquireVsCodeApi() can only be called once, so we cache it here

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Acquire the API once and export it
export const vscode = acquireVsCodeApi();
