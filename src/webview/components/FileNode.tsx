import React, { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';

interface FileNodeData {
  label: string;
  filePath: string;
  relativePath: string;
  pluginName?: string;
  isHighlighted: boolean;
  isActive: boolean;
  onDelete: () => void;
  onClick: () => void;
}

interface FileNodeProps {
  data: FileNodeData;
}

export const FileNode = memo(({ data }: FileNodeProps) => {
  const [isHovered, setIsHovered] = useState(false);

  // Get file extension for icon
  const extension = data.label.split('.').pop()?.toLowerCase() || '';

  // Get icon based on extension
  const getIcon = () => {
    const iconMap: Record<string, string> = {
      ts: '🔷',
      tsx: '⚛️',
      js: '🟨',
      jsx: '⚛️',
      json: '📋',
      css: '🎨',
      scss: '🎨',
      html: '🌐',
      md: '📝',
      py: '🐍',
      rs: '🦀',
      go: '🐹',
      java: '☕',
      rb: '💎',
      php: '🐘',
      vue: '💚',
      svelte: '🧡',
    };
    return iconMap[extension] || '📄';
  };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        data.onClick();
      }}
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        background: data.isHighlighted
          ? 'var(--vscode-inputValidation-infoBackground, #063b49)'
          : 'var(--vscode-editor-background, #1e1e1e)',
        border: `2px solid ${
          data.isHighlighted
            ? 'var(--vscode-inputValidation-infoBorder, #007acc)'
            : isHovered
            ? 'var(--vscode-focusBorder, #007acc)'
            : 'var(--vscode-panel-border, #3c3c3c)'
        }`,
        boxShadow: data.isHighlighted
          ? '0 0 20px rgba(0, 122, 204, 0.4)'
          : isHovered
          ? '0 4px 12px rgba(0, 0, 0, 0.3)'
          : '0 2px 8px rgba(0, 0, 0, 0.2)',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        minWidth: '120px',
        maxWidth: '200px',
        position: 'relative',
        opacity: data.isActive ? 1 : 0.5,
      }}
    >
      {/* Connection handles */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: 'var(--vscode-charts-blue, #4fc3f7)',
          border: '2px solid var(--vscode-editor-background)',
          width: 10,
          height: 10,
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: 'var(--vscode-charts-blue, #4fc3f7)',
          border: '2px solid var(--vscode-editor-background)',
          width: 10,
          height: 10,
        }}
      />

      {/* Delete button */}
      {isHovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            data.onDelete();
          }}
          style={{
            position: 'absolute',
            top: -8,
            right: -8,
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: 'none',
            background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
            color: 'var(--vscode-errorForeground, #f48771)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            fontWeight: 'bold',
            transition: 'all 0.2s ease',
          }}
          title="Remove node"
        >
          ×
        </button>
      )}

      {/* Content */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {/* Filename row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '16px' }}>{getIcon()}</span>
          <span
            style={{
              color: 'var(--vscode-editor-foreground, #cccccc)',
              fontSize: '12px',
              fontFamily: 'var(--vscode-font-family)',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={data.filePath}
          >
            {data.label}
          </span>
        </div>

        {/* Plugin name */}
        {data.pluginName && (
          <div
            style={{
              fontSize: '10px',
              color: 'var(--vscode-charts-purple, #c586c0)',
              fontFamily: 'var(--vscode-font-family)',
              paddingLeft: '24px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.pluginName}
          </div>
        )}

        {/* Relative path */}
        <div
          style={{
            fontSize: '10px',
            color: 'var(--vscode-descriptionForeground, #808080)',
            fontFamily: 'var(--vscode-font-family)',
            paddingLeft: '24px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={data.relativePath}
        >
          {data.relativePath}
        </div>
      </div>

      {/* File path tooltip on hover */}
      {isHovered && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '8px',
            padding: '6px 10px',
            background: 'var(--vscode-editorWidget-background, #252526)',
            border: '1px solid var(--vscode-editorWidget-border, #454545)',
            borderRadius: '4px',
            fontSize: '11px',
            color: 'var(--vscode-editorWidget-foreground, #cccccc)',
            whiteSpace: 'nowrap',
            maxWidth: '300px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            zIndex: 100,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
          }}
        >
          {data.filePath}
        </div>
      )}
    </div>
  );
});

FileNode.displayName = 'FileNode';
