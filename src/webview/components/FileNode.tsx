import React, { memo, useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import type { SymbolInfo } from '../../types';
import { vscode } from '../vscodeApi';

interface FileNodeData {
  label: string;
  filePath: string;
  relativePath: string;
  pluginName?: string;
  symbols?: SymbolInfo[]; // Symbols navigated TO (destination)
  sourceSymbols?: SymbolInfo[]; // Symbols navigated FROM (source context)
  isHighlighted: boolean;
  isActive: boolean;
  onDelete: () => void;
  onClick: () => void;
}

interface FileNodeProps {
  data: FileNodeData;
}

interface CodePreview {
  lines: string[];
  startLine: number;
  highlightLine: number;
}

// Global state to track pending code preview requests
const pendingRequests = new Map<string, (preview: CodePreview) => void>();

// Listen for code preview responses
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'codePreview' && message.requestId) {
      const resolver = pendingRequests.get(message.requestId);
      if (resolver) {
        resolver({
          lines: message.lines,
          startLine: message.startLine,
          highlightLine: message.highlightLine,
        });
        pendingRequests.delete(message.requestId);
      }
    }
  });
}

// Request code preview from extension
function requestCodePreview(filePath: string, line: number, contextLines: number = 10): Promise<CodePreview> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    pendingRequests.set(requestId, resolve);
    
    vscode.postMessage({
      type: 'requestCodePreview',
      requestId,
      filePath,
      line,
      contextLines,
    });
    
    // Timeout after 2 seconds
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        resolve({ lines: [], startLine: line, highlightLine: line });
      }
    }, 2000);
  });
}

// Symbol tag component with hover preview
const SymbolTag = memo(({ symbol, isSource }: { symbol: SymbolInfo; isSource: boolean }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [codePreview, setCodePreview] = useState<CodePreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{ x: number; y: number } | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const spanRef = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(async () => {
      // Calculate position for the portal popover
      if (spanRef.current) {
        const rect = spanRef.current.getBoundingClientRect();
        setPopoverPosition({
          x: rect.left + rect.width / 2,
          y: rect.top,
        });
      }
      setIsHovered(true);
      setIsLoading(true);
      const preview = await requestCodePreview(symbol.filePath, symbol.line, 10);
      setCodePreview(preview);
      setIsLoading(false);
    }, 300); // 300ms delay before showing preview
  }, [symbol.filePath, symbol.line]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(false);
    setCodePreview(null);
    setPopoverPosition(null);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Render popover via portal to avoid opacity inheritance
  const popover = isHovered && popoverPosition && createPortal(
    <div
      style={{
        position: 'fixed',
        left: popoverPosition.x,
        top: popoverPosition.y,
        transform: 'translate(-50%, -100%)',
        marginTop: '-8px',
        background: 'var(--vscode-editor-background, #1e1e1e)',
        border: '1px solid var(--vscode-editorWidget-border, #454545)',
        borderRadius: '6px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
        zIndex: 10000,
        minWidth: '400px',
        maxWidth: '600px',
        overflow: 'hidden',
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => {
        if (hoverTimeoutRef.current) {
          clearTimeout(hoverTimeoutRef.current);
        }
      }}
      onMouseLeave={handleMouseLeave}
    >
      {/* Header */}
      <div
        style={{
          padding: '6px 10px',
          background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)',
          borderBottom: '1px solid var(--vscode-editorWidget-border, #454545)',
          fontSize: '11px',
          color: 'var(--vscode-descriptionForeground, #808080)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--vscode-charts-blue, #4fc3f7)' }}>
          {symbol.name}
        </span>
        <span>Line {symbol.line}</span>
      </div>
      
      {/* Code Preview */}
      <div
        style={{
          padding: '8px 0',
          maxHeight: '300px',
          overflowY: 'auto',
          fontSize: '12px',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          lineHeight: '1.5',
        }}
      >
        {isLoading ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
            Loading...
          </div>
        ) : codePreview && codePreview.lines.length > 0 ? (
          codePreview.lines.map((line, index) => {
            const lineNumber = codePreview.startLine + index;
            const isHighlight = lineNumber === codePreview.highlightLine;
            return (
              <div
                key={index}
                style={{
                  display: 'flex',
                  background: isHighlight 
                    ? 'rgba(79, 195, 247, 0.15)' 
                    : 'transparent',
                  borderLeft: isHighlight 
                    ? '3px solid var(--vscode-charts-blue, #4fc3f7)' 
                    : '3px solid transparent',
                }}
              >
                <span
                  style={{
                    width: '40px',
                    paddingRight: '8px',
                    textAlign: 'right',
                    color: isHighlight 
                      ? 'var(--vscode-charts-blue, #4fc3f7)' 
                      : 'var(--vscode-editorLineNumber-foreground, #5a5a5a)',
                    userSelect: 'none',
                    flexShrink: 0,
                  }}
                >
                  {lineNumber}
                </span>
                <pre
                  style={{
                    margin: 0,
                    paddingRight: '12px',
                    whiteSpace: 'pre',
                    color: 'var(--vscode-editor-foreground, #d4d4d4)',
                    flex: 1,
                    overflow: 'hidden',
                  }}
                >
                  {line || ' '}
                </pre>
              </div>
            );
          })
        ) : (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
            No preview available
          </div>
        )}
      </div>
    </div>,
    document.body
  );

  return (
    <span
      ref={spanRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      <span
        style={{
          fontSize: '12px',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          fontWeight: 600,
          color: 'var(--vscode-charts-blue, #4fc3f7)',
          background: isHovered ? 'rgba(79, 195, 247, 0.15)' : 'transparent',
          borderRadius: '3px',
          padding: '0 2px',
          transition: 'background 0.15s ease',
        }}
        title={`${isSource ? 'Contains reference' : 'Navigated to'}: ${symbol.name} (line ${symbol.line})`}
      >
        {symbol.name}
      </span>
      {popover}
    </span>
  );
});

SymbolTag.displayName = 'SymbolTag';

export const FileNode = memo(({ data }: FileNodeProps) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      data-node-type="file-node"
      data-file-path={data.filePath}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        data.onClick();
      }}
      style={{
        position: 'relative',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Main node content - this gets the opacity */}
      <div
        style={{
          padding: '8px',
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
          position: 'relative',
          opacity: data.isActive ? 1 : 0.5,
        }}
      >
      {/* Connection handles - all sides with both source and target types */}
      {/* Handles are invisible but functional for edge connections */}
      {/* Left handles */}
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <Handle
        id="left-source"
        type="source"
        position={Position.Left}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      {/* Right handles */}
      <Handle
        id="right-target"
        type="target"
        position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <Handle
        id="right-source"
        type="source"
        position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      {/* Top handles */}
      <Handle
        id="top-target"
        type="target"
        position={Position.Top}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <Handle
        id="top-source"
        type="source"
        position={Position.Top}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      {/* Bottom handles */}
      <Handle
        id="bottom-target"
        type="target"
        position={Position.Bottom}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, width: 1, height: 1 }}
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
        {/* Source symbols row - functions/classes that contain outgoing references */}
        {data.sourceSymbols && data.sourceSymbols.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: '14px', color: 'var(--vscode-charts-blue, #4fc3f7)' }}>ƒ</span>
            {data.sourceSymbols.slice(0, 3).map((symbol, idx) => (
              <React.Fragment key={`${symbol.name}-${symbol.line}`}>
                {idx > 0 && <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '10px' }}>,</span>}
                <SymbolTag symbol={symbol} isSource={true} />
              </React.Fragment>
            ))}
            {data.sourceSymbols.length > 3 && (
              <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
                +{data.sourceSymbols.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Destination symbols row - symbols that were navigated to */}
        {data.symbols && data.symbols.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: '14px', color: 'var(--vscode-charts-blue, #4fc3f7)' }}>ƒ</span>
            {data.symbols.slice(0, 3).map((symbol, idx) => (
              <React.Fragment key={`${symbol.name}-${symbol.line}`}>
                {idx > 0 && <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '10px' }}>,</span>}
                <SymbolTag symbol={symbol} isSource={false} />
              </React.Fragment>
            ))}
            {data.symbols.length > 3 && (
              <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
                +{data.symbols.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Filename row - shown prominently when no symbols */}
        {!(data.symbols?.length || data.sourceSymbols?.length) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
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
        )}

        {/* File path (combined: relativePath/filename) - secondary when symbols exist, or just path when no symbols */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          {(data.symbols?.length || data.sourceSymbols?.length) ? (
            <>
              <span
                style={{
                  color: 'var(--vscode-descriptionForeground, #808080)',
                  fontSize: '10px',
                  fontFamily: 'var(--vscode-font-family)',
                  fontWeight: 400,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={data.filePath}
              >
                {data.relativePath && data.relativePath !== '.' 
                  ? `${data.relativePath}/${data.label}` 
                  : data.label}
              </span>
            </>
          ) : (
            <span
              style={{
                color: 'var(--vscode-descriptionForeground, #808080)',
                fontSize: '10px',
                fontFamily: 'var(--vscode-font-family)',
                fontWeight: 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={data.relativePath}
            >
              {data.relativePath && data.relativePath !== '.' ? data.relativePath : ''}
            </span>
          )}
        </div>
      </div>
      </div>

      {/* File path tooltip on hover - outside opacity wrapper for full visibility */}
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
            maxWidth: '500px',
            overflow: 'hidden',
            textOverflow: 'wrap',
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
