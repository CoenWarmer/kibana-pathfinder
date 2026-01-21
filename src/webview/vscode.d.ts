// Type declarations for VS Code webview API

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Global variable set by the webview HTML for the worker URL
interface Window {
  forceLayoutWorkerUrl?: string;
}


