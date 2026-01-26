import React, { memo, useState, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileSearchResult, ImportedExport } from '../../types';

interface GroupNodeData {
  label: string;
  groupType?: 'plugin' | 'path' | 'dependency';
  hasNodes?: boolean;
  searchResults?: FileSearchResult[];
  onSearch?: (pluginId: string, query: string) => void;
  onFileSelect?: (filePath: string) => void;
  onOpenPluginIndex?: (pluginId: string) => void;
  isCompleteMode?: boolean;
  pluginPath?: string; // Path to the plugin directory
  isLoading?: boolean; // TypeScript is loading for this plugin
  parentPluginId?: string; // For dependency groups: the main plugin that depends on this
  onAnalyzeImports?: (mainPluginId: string, dependencyPluginId: string) => void;
  importAnalysis?: ImportedExport[]; // Results from import analysis
  isAnalyzingImports?: boolean;
  showImportAnalysis?: boolean; // Controlled from parent - whether to show the import analysis popup
  onToggleImportAnalysis?: (dependencyLabel: string | null) => void; // Toggle callback
  onOpenImportSource?: (importPath: string, symbolName: string) => void; // Open file where symbol is defined
  onSearchActiveChange?: (isActive: boolean) => void; // Notify parent when file search is active (for z-index boosting)
}

interface GroupNodeProps {
  data: GroupNodeData;
}

const handleStyle = {
  background: 'var(--vscode-editorLineNumber-foreground, #5a5a5a)',
  width: 6,
  height: 6,
  border: 'none',
};

export const GroupNode = memo(({ data }: GroupNodeProps) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDependency = data.groupType === 'dependency';
  const isEmpty = !data.hasNodes;
  
  // Use controlled state from parent
  const showImportAnalysis = data.showImportAnalysis ?? false;

  // Handle analyze imports button click - toggle behavior
  const handleAnalyzeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.onToggleImportAnalysis) {
      if (showImportAnalysis) {
        // Close if already open
        data.onToggleImportAnalysis(null);
      } else {
        // Open and trigger analysis
        data.onToggleImportAnalysis(data.label);
        if (data.onAnalyzeImports && data.parentPluginId) {
          data.onAnalyzeImports(data.parentPluginId, data.label);
        }
      }
    }
  };
  
  // Close popup handler
  const handleClosePopup = () => {
    if (data.onToggleImportAnalysis) {
      data.onToggleImportAnalysis(null);
    }
  };

  // Focus input when search mode is activated
  useEffect(() => {
    if (isSearching && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isSearching]);

  // Notify parent when search state changes (for z-index boosting)
  // Note: We intentionally exclude data.onSearchActiveChange from deps to avoid
  // cascading re-renders when the callback reference changes
  useEffect(() => {
    if (data.onSearchActiveChange) {
      data.onSearchActiveChange(isSearching);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSearching]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [data.searchResults]);

  const handlePlusClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSearching(true);
    setSearchQuery('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    if (data.onSearch && query.length > 0) {
      data.onSearch(data.label, query);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const results = data.searchResults || [];
    
    if (e.key === 'Escape') {
      setIsSearching(false);
      setSearchQuery('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected && data.onFileSelect) {
        data.onFileSelect(selected.filePath);
        setIsSearching(false);
        setSearchQuery('');
      }
    }
  };

  const handleResultClick = (filePath: string) => {
    if (data.onFileSelect) {
      data.onFileSelect(filePath);
      setIsSearching(false);
      setSearchQuery('');
    }
  };

  const handleBlur = () => {
    // Delay to allow click on results
    setTimeout(() => {
      setIsSearching(false);
      setSearchQuery('');
    }, 200);
  };

  // Handle double-click to open plugin index file
  const handleDoubleClick = () => {
    if (isDependency && data.onOpenPluginIndex) {
      data.onOpenPluginIndex(data.label);
    }
  };

  // Compact style for empty groups (both plugin and dependency groups)
  if (isEmpty) {
    // In Complete mode, all groups should have full opacity
    // const nodeOpacity = data.isCompleteMode ? 1 : (isSearching ? 1 : 0.6);
    const nodeOpacity = 1;
    
    return (
      <div
        data-node-type="group-node-compact"
        data-group-label={data.label}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onDoubleClick={handleDoubleClick}
        style={{
          padding: '8px 12px',
          borderRadius: '8px',
          background: isHovered || isSearching
            ? 'var(--vscode-editor-background, rgba(255, 255, 255, 0.08))'
            : 'var(--vscode-editor-background, rgba(255, 255, 255, 0.03))',
          border: '1px dashed var(--vscode-panel-border, #3c3c3c)',
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
          opacity: nodeOpacity,
          transition: 'all 0.2s ease',
          cursor: 'pointer',
          position: 'relative',
          overflow: 'visible',
        }}
      >
        {/* Handles for edges - both source and target handles for connectivity */}
        <Handle type="source" position={Position.Top} id="top-source" style={handleStyle} />
        <Handle type="source" position={Position.Right} id="right-source" style={handleStyle} />
        <Handle type="source" position={Position.Bottom} id="bottom-source" style={handleStyle} />
        <Handle type="source" position={Position.Left} id="left-source" style={handleStyle} />
        <Handle type="target" position={Position.Top} id="top-target" style={handleStyle} />
        <Handle type="target" position={Position.Right} id="right-target" style={handleStyle} />
        <Handle type="target" position={Position.Bottom} id="bottom-target" style={handleStyle} />
        <Handle type="target" position={Position.Left} id="left-target" style={handleStyle} />
        
        <div
          style={{
            fontSize: '9px',
            fontWeight: 500,
            color: 'var(--vscode-descriptionForeground, #808080)',
            textTransform: 'uppercase',
            letterSpacing: '0.3px',
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
          }}
          title={data.label}
        >
          {data.label}
        </div>

        {/* Import analysis results */}
        {showImportAnalysis && data.importAnalysis && data.importAnalysis.length > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: '8px',
              background: 'var(--vscode-editor-background, #1e1e1e)',
              border: '1px solid var(--vscode-editorWidget-border, #454545)',
              borderRadius: '6px',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
              zIndex: 100,
              minWidth: '250px',
              maxWidth: '400px',
              maxHeight: '300px',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--vscode-panel-border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--vscode-charts-blue)' }}>
                Imports from {data.label}
              </span>
              <button
                onClick={handleClosePopup}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--vscode-descriptionForeground)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '0 4px',
                }}
              >
                ×
              </button>
            </div>
            <div style={{ padding: '8px' }}>
              {data.importAnalysis.map((imp, idx) => (
                <div
                  key={`${imp.name}-${idx}`}
                  style={{
                    padding: '6px 0',
                    fontSize: '11px',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    borderBottom: idx < data.importAnalysis!.length - 1 ? '1px solid var(--vscode-panel-border)' : 'none',
                  }}
                >
                  {/* Symbol name - clickable to open where symbol is defined */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      if (data.onOpenImportSource && imp.sourcePath) {
                        data.onOpenImportSource(imp.sourcePath, imp.name);
                      }
                    }}
                    style={{
                      color: imp.isDefault ? 'var(--vscode-charts-orange, #ce9178)' : 'var(--vscode-charts-blue, #4fc3f7)',
                      cursor: data.onOpenImportSource ? 'pointer' : 'default',
                      fontWeight: 600,
                    }}
                    title={`Click to go to definition of ${imp.name}`}
                  >
                    {imp.isDefault ? (imp.alias || 'default') : imp.name}
                  </span>
                  {imp.alias && imp.alias !== imp.name && !imp.isDefault && (
                    <span style={{ color: 'var(--vscode-descriptionForeground)' }}> as {imp.alias}</span>
                  )}
                  {/* Source path - where the export is defined */}
                  <div style={{ fontSize: '9px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' }}>
                    from {imp.sourcePath?.replace(/^@kbn\/[^/]+\/?/, '') || '...'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state for import analysis */}
        {showImportAnalysis && data.importAnalysis && data.importAnalysis.length === 0 && !data.isAnalyzingImports && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: '8px',
              padding: '12px 16px',
              background: 'var(--vscode-editor-background, #1e1e1e)',
              border: '1px solid var(--vscode-editorWidget-border, #454545)',
              borderRadius: '6px',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
              zIndex: 100,
              fontSize: '11px',
              color: 'var(--vscode-descriptionForeground)',
            }}
          >
            No imports found
          </div>
        )}

        {/* Loading state */}
        {showImportAnalysis && data.isAnalyzingImports && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: '8px',
              padding: '12px 16px',
              background: 'var(--vscode-editor-background, #1e1e1e)',
              border: '1px solid var(--vscode-editorWidget-border, #454545)',
              borderRadius: '6px',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
              zIndex: 100,
              fontSize: '11px',
              color: 'var(--vscode-descriptionForeground)',
            }}
          >
            Analyzing imports...
          </div>
        )}

        {isSearching ? (
          <div style={{ position: 'relative', width: '100%' }}>
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              placeholder="Search files..."
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: '11px',
                background: 'var(--vscode-input-background, #3c3c3c)',
                color: 'var(--vscode-input-foreground, #cccccc)',
                border: '1px solid var(--vscode-input-border, #3c3c3c)',
                borderRadius: '4px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {/* Autocomplete dropdown */}
            {data.searchResults && data.searchResults.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '4px',
                  background: 'var(--vscode-dropdown-background, #252526)',
                  border: '1px solid var(--vscode-dropdown-border, #3c3c3c)',
                  borderRadius: '4px',
                  maxHeight: '150px',
                  overflowY: 'auto',
                  zIndex: 10000,
                  minWidth: '200px',
                }}
              >
                {data.searchResults.map((result, index) => (
                  <div
                    key={result.filePath}
                    onClick={() => handleResultClick(result.filePath)}
                    style={{
                      padding: '6px 8px',
                      cursor: 'pointer',
                      background: index === selectedIndex 
                        ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                        : 'transparent',
                      color: index === selectedIndex
                        ? 'var(--vscode-list-activeSelectionForeground, #ffffff)'
                        : 'var(--vscode-dropdown-foreground, #cccccc)',
                    }}
                  >
                    <div style={{ fontSize: '11px', fontWeight: 500 }}>
                      {result.fileName}
                    </div>
                    <div style={{ fontSize: '9px', opacity: 0.7 }}>
                      {result.relativePath}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '4px' }}>
            {/* Show imports button - only in Plugin mode for dependency groups */}
            {data.parentPluginId && data.onAnalyzeImports && (
              <div
                onClick={handleAnalyzeClick}
                title="Show imports from this plugin"
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '4px',
                  background: showImportAnalysis 
                    ? 'var(--vscode-button-background, #0e639c)' 
                    : 'var(--vscode-button-secondaryBackground, #3a3d41)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10px',
                  color: 'var(--vscode-button-secondaryForeground, #cccccc)',
                  cursor: 'pointer',
                }}
              >
                ↓
              </div>
            )}
            {/* Add file button */}
            <div
              onClick={handlePlusClick}
              style={{
                width: '18px',
                height: '18px',
                borderRadius: '4px',
                background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                color: 'var(--vscode-button-secondaryForeground, #cccccc)',
                cursor: 'pointer',
              }}
            >
              +
            </div>
          </div>
        )}
      </div>
    );
  }

  // Full style for plugin groups or groups with nodes
  return (
    <div
      data-node-type="group-node-full"
      data-group-label={data.label}
      style={{
        padding: '8px',
        borderRadius: '12px',
        background: 'var(--vscode-editor-background, rgba(255, 255, 255, 0.05))',
        border: '2px dashed var(--vscode-panel-border, #3c3c3c)',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        overflow: 'visible',
      }}
    >
      {/* Handles for edges - both source and target handles for connectivity */}
      <Handle type="source" position={Position.Top} id="top-source" style={handleStyle} />
      <Handle type="source" position={Position.Right} id="right-source" style={handleStyle} />
      <Handle type="source" position={Position.Bottom} id="bottom-source" style={handleStyle} />
      <Handle type="source" position={Position.Left} id="left-source" style={handleStyle} />
      <Handle type="target" position={Position.Top} id="top-target" style={handleStyle} />
      <Handle type="target" position={Position.Right} id="right-target" style={handleStyle} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={handleStyle} />
      <Handle type="target" position={Position.Left} id="left-target" style={handleStyle} />
      
      {/* Group header */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          marginBottom: '10px',
          paddingBottom: '8px',
          borderBottom: '1px solid var(--vscode-panel-border, #3c3c3c)',
        }}
      >
        <div
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--vscode-charts-purple, #c586c0)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
            flexGrow: 1,
          }}
        >
          <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', gap: '8px', justifyContent: 'space-between'}}>
            📦 {data.label}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px' }}>
              {data.isLoading && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '10px',
                    height: '10px',
                    border: '2px solid var(--vscode-progressBar-background, #0078d4)',
                    opacity: 0.5,
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }}
                  title="TypeScript is loading..."
                />
              )}
              {/* Plus button to add files */}
              {!isSearching && (
                <div
                  onClick={handlePlusClick}
                  title="Search and open a file"
                  style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '4px',
                    background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    color: 'var(--vscode-button-secondaryForeground, #cccccc)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  +
                </div>
              )}
              </div>
          </div>
        </div>
        {data.pluginPath && (
          <div
            style={{
              fontSize: '9px',
              color: 'var(--vscode-descriptionForeground, #808080)',
              marginTop: '4px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={data.pluginPath}
          >
            {data.pluginPath}
          </div>
        )}
        {/* Search input for full group */}
        {isSearching && (
          <div style={{ position: 'relative', marginTop: '8px' }}>
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              placeholder="Search files..."
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: '11px',
                background: 'var(--vscode-input-background, #3c3c3c)',
                color: 'var(--vscode-input-foreground, #cccccc)',
                border: '1px solid var(--vscode-input-border, #3c3c3c)',
                borderRadius: '4px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {/* Autocomplete dropdown */}
            {data.searchResults && data.searchResults.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '4px',
                  background: 'var(--vscode-dropdown-background, #252526)',
                  border: '1px solid var(--vscode-dropdown-border, #3c3c3c)',
                  borderRadius: '4px',
                  maxHeight: '150px',
                  overflowY: 'auto',
                  zIndex: 10000,
                }}
              >
                {data.searchResults.map((result, index) => (
                  <div
                    key={result.filePath}
                    onClick={() => handleResultClick(result.filePath)}
                    style={{
                      padding: '6px 8px',
                      cursor: 'pointer',
                      background: index === selectedIndex 
                        ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                        : 'transparent',
                      color: index === selectedIndex
                        ? 'var(--vscode-list-activeSelectionForeground, #ffffff)'
                        : 'var(--vscode-dropdown-foreground, #cccccc)',
                    }}
                  >
                    <div style={{ fontSize: '11px', fontWeight: 500 }}>
                      {result.fileName}
                    </div>
                    <div style={{ fontSize: '9px', opacity: 0.7 }}>
                      {result.relativePath}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

GroupNode.displayName = 'GroupNode';
