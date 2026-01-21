import React, { memo, useState, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileSearchResult } from '../../types';

interface GroupNodeData {
  label: string;
  groupType?: 'plugin' | 'path' | 'dependency';
  hasNodes?: boolean;
  searchResults?: FileSearchResult[];
  onSearch?: (pluginId: string, query: string) => void;
  onFileSelect?: (filePath: string) => void;
  onOpenPluginIndex?: (pluginId: string) => void;
  isCompleteMode?: boolean;
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

  // Focus input when search mode is activated
  useEffect(() => {
    if (isSearching && inputRef.current) {
      inputRef.current.focus();
    }
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

  // Compact style for empty dependency groups
  if (isDependency && isEmpty) {
    // In Complete mode, all groups should have full opacity
    const nodeOpacity = data.isCompleteMode ? 1 : (isSearching ? 1 : 0.6);
    
    return (
      <div
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
                  zIndex: 1000,
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
        )}
      </div>
    );
  }

  // Full style for plugin groups or groups with nodes
  return (
    <div
      style={{
        padding: '10px',
        borderRadius: '12px',
        background: 'var(--vscode-editor-background, rgba(255, 255, 255, 0.05))',
        border: '2px dashed var(--vscode-panel-border, #3c3c3c)',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
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
          fontSize: '11px',
          fontWeight: 600,
          color: 'var(--vscode-charts-purple, #c586c0)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '10px',
          paddingBottom: '8px',
          borderBottom: '1px solid var(--vscode-panel-border, #3c3c3c)',
        }}
      >
        📦 {data.label}
      </div>
    </div>
  );
});

GroupNode.displayName = 'GroupNode';
