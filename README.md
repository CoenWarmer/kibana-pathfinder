# Kibana Pathfinder

A Visual Studio Code extension that visualizes your Kibana codebase navigation as an interactive graph. Track file journeys, explore plugin dependencies, and map the complete plugin architecture.

<img alt="Screen_Shot_2021-01-04_at_2 02 15_PM" src="https://github.com/user-attachments/assets/cbf3e17d-457b-4b9d-8de5-bf239bbd2ac4" />


## Features

- **Three Viewing Modes**:
  - **Journey Mode**: Track your file-to-file navigation paths
  - **Plugin Mode**: See plugin groups with their dependencies
  - **Complete Mode**: View the entire Kibana plugin architecture

- **Interactive Graph Visualization**: See your file navigation as connected nodes in a React Flow graph
- **Real-time Updates**: Nodes and edges appear automatically as you navigate between files
- **Plugin Dependency Mapping**: Automatically discovers and displays plugin dependencies from `kibana.jsonc`
- **Persistent State**: Your navigation graph is saved and restored between VSCode sessions
- **Full Controls**: Zoom, pan, minimap, and the ability to delete individual nodes
- **File Quick Access**: Click any node to jump directly to that file
- **Plugin Search**: Search for any plugin in Complete mode and zoom to it
- **Beautiful Design**: Seamlessly integrates with your VSCode theme

## Installation

### From Source

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Press `F5` in VSCode to launch the Extension Development Host

### From VSIX

1. Build the VSIX package:
   ```bash
   npx vsce package
   ```
2. Install from VSIX in VSCode

## Usage

1. Open the Pathfinder panel from the Activity Bar (left sidebar)
2. Start navigating through your Kibana codebase
3. Watch as your navigation path is visualized as a graph
4. Switch between Journey, Plugin, and Complete modes using the toggle
5. Click on any node to open that file
6. Double-click on dependency nodes to open the plugin's index file
7. Use the search bar in Complete mode to find and zoom to specific plugins
8. Hover over nodes to see the full file path
9. Delete nodes by hovering and clicking the × button
10. Use the Clear button to reset the graph

## Commands

- `Pathfinder: Open Pathfinder Panel` - Opens and focuses the Pathfinder panel
- `Pathfinder: Clear Navigation Graph` - Clears all nodes and edges

## Development

```bash
# Install dependencies
npm install

# Watch mode for development
npm run watch

# Build for production
npm run build

# Run linting
npm run lint
```

## Architecture

The extension consists of two main parts:

1. **Extension Host** (Node.js)
   - Tracks file navigation events
   - Discovers Kibana plugins and their dependencies
   - Manages state persistence
   - Communicates with the webview

2. **Webview** (React + React Flow)
   - Renders the interactive graph with force-directed layout
   - Handles user interactions
   - Provides zoom, pan, and minimap controls
   - Implements plugin search with autocomplete

## License

MIT
