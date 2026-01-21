import * as vscode from 'vscode';
import { FileNode, NavigationEdge, GraphState, GroupNode } from './types';

const STATE_KEY = 'pathfinder.graphState';

export class StateManager {
  private _state: GraphState;

  constructor(private readonly _context: vscode.ExtensionContext) {
    // Load state from workspace storage
    this._state = this._loadState();
  }

  private _loadState(): GraphState {
    const savedState = this._context.workspaceState.get<GraphState>(STATE_KEY);
    if (savedState) {
      // Ensure groups array exists for backwards compatibility
      return { ...savedState, groups: savedState.groups || [] };
    }
    return { nodes: [], edges: [], groups: [] };
  }

  private _persistState() {
    this._context.workspaceState.update(STATE_KEY, this._state);
  }

  public getState(): GraphState {
    return { ...this._state };
  }

  public saveState(state: GraphState) {
    this._state = state;
    this._persistState();
  }

  public addNode(node: FileNode) {
    // Check if node already exists
    const exists = this._state.nodes.some((n) => n.id === node.id);
    if (!exists) {
      this._state.nodes.push(node);
      this._persistState();
    }
  }

  public addEdge(edge: NavigationEdge) {
    // Check if edge already exists
    const exists = this._state.edges.some((e) => e.id === edge.id);
    if (!exists) {
      this._state.edges.push(edge);
      this._persistState();
    }
  }

  public deleteNode(nodeId: string) {
    // Remove the node
    this._state.nodes = this._state.nodes.filter((n) => n.id !== nodeId);
    // Remove all edges connected to this node
    this._state.edges = this._state.edges.filter(
      (e) => e.source !== nodeId && e.target !== nodeId
    );
    this._persistState();
  }

  public updateNodePosition(nodeId: string, position: { x: number; y: number }) {
    const node = this._state.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.position = position;
      this._persistState();
    }
  }

  public addGroup(group: GroupNode) {
    const exists = this._state.groups.some((g) => g.id === group.id);
    if (!exists) {
      this._state.groups.push(group);
      this._persistState();
    }
  }

  public updateGroup(group: GroupNode) {
    const index = this._state.groups.findIndex((g) => g.id === group.id);
    if (index >= 0) {
      this._state.groups[index] = group;
      this._persistState();
    }
  }

  public getGroup(groupId: string): GroupNode | undefined {
    return this._state.groups.find((g) => g.id === groupId);
  }

  public deleteGroup(groupId: string) {
    this._state.groups = this._state.groups.filter((g) => g.id !== groupId);
    this._persistState();
  }

  public getNodesInGroup(groupId: string): FileNode[] {
    return this._state.nodes.filter((n) => n.groupId === groupId);
  }

  public clearState() {
    this._state = { nodes: [], edges: [], groups: [] };
    this._persistState();
  }
}


