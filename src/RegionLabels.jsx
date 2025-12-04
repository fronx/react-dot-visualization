import React, { useState, useRef, useCallback } from 'react';

const RegionLabels = ({
  labels = [],
  onLabelClick,
  onLabelHover,
  onLabelLeave,
  onLabelDragStart,
  onLabelDrag,
  onLabelDragEnd,
  dragEnabled = false,
  dragModifierKey = null, // 'shift' | 'alt' | 'meta' | null
  getZoomTransform,
  renderLabel,
  className = '',
  debug = false
}) => {
  // Drag state
  const [dragState, setDragState] = useState({
    isDragging: false,
    draggedLabelId: null,
    startScreenPos: null,
    currentWorldOffset: null
  });

  const svgRef = useRef(null);

  // Check if modifier key is pressed
  const isModifierKeyPressed = useCallback((event) => {
    if (!dragModifierKey) return true; // No modifier required

    switch (dragModifierKey) {
      case 'shift':
        return event.shiftKey;
      case 'alt':
        return event.altKey;
      case 'meta':
        return event.metaKey || event.ctrlKey; // Cmd on Mac, Ctrl on Windows
      default:
        return false;
    }
  }, [dragModifierKey]);

  // Convert screen delta to world delta
  const screenToWorldDelta = useCallback((screenDX, screenDY) => {
    if (!getZoomTransform) return { dx: screenDX, dy: screenDY };

    const transform = getZoomTransform();
    if (!transform) return { dx: screenDX, dy: screenDY };

    // World delta = screen delta / zoom scale
    return {
      dx: screenDX / transform.k,
      dy: screenDY / transform.k
    };
  }, [getZoomTransform]);

  // Handle drag start
  const handleMouseDown = useCallback((event, label) => {
    if (!dragEnabled || !isModifierKeyPressed(event)) return;

    // Prevent both React synthetic event and native event from propagating
    event.preventDefault();
    event.stopPropagation();
    // Stop native event to prevent D3 zoom/pan from activating
    if (event.nativeEvent) {
      event.nativeEvent.stopImmediatePropagation();
    }

    const screenX = event.clientX;
    const screenY = event.clientY;

    setDragState({
      isDragging: true,
      draggedLabelId: label.id,
      startScreenPos: { x: screenX, y: screenY },
      currentWorldOffset: { dx: 0, dy: 0 }
    });

    if (onLabelDragStart) {
      onLabelDragStart(label);
    }

    if (debug) {
      console.log('[RegionLabels] Drag start:', { labelId: label.id, screenX, screenY });
    }
  }, [dragEnabled, isModifierKeyPressed, onLabelDragStart, debug]);

  // Handle drag move
  const handleMouseMove = useCallback((event) => {
    if (!dragState.isDragging || !dragState.startScreenPos) return;

    const screenX = event.clientX;
    const screenY = event.clientY;

    const screenDX = screenX - dragState.startScreenPos.x;
    const screenDY = screenY - dragState.startScreenPos.y;

    const worldOffset = screenToWorldDelta(screenDX, screenDY);

    setDragState(prev => ({
      ...prev,
      currentWorldOffset: worldOffset
    }));

    const draggedLabel = labels.find(l => l.id === dragState.draggedLabelId);
    if (onLabelDrag && draggedLabel) {
      onLabelDrag(draggedLabel, worldOffset);
    }

    if (debug) {
      console.log('[RegionLabels] Dragging:', { screenDX, screenDY, worldOffset });
    }
  }, [dragState.isDragging, dragState.startScreenPos, dragState.draggedLabelId, labels, screenToWorldDelta, onLabelDrag, debug]);

  // Handle drag end
  const handleMouseUp = useCallback(() => {
    if (!dragState.isDragging) return;

    const draggedLabel = labels.find(l => l.id === dragState.draggedLabelId);

    if (onLabelDragEnd && draggedLabel && dragState.currentWorldOffset) {
      onLabelDragEnd(draggedLabel, dragState.currentWorldOffset);
    }

    if (debug) {
      console.log('[RegionLabels] Drag end:', {
        labelId: dragState.draggedLabelId,
        worldOffset: dragState.currentWorldOffset
      });
    }

    setDragState({
      isDragging: false,
      draggedLabelId: null,
      startScreenPos: null,
      currentWorldOffset: null
    });
  }, [dragState.isDragging, dragState.draggedLabelId, dragState.currentWorldOffset, labels, onLabelDragEnd, debug]);

  // Attach global mouse listeners for drag
  React.useEffect(() => {
    if (dragState.isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragState.isDragging, handleMouseMove, handleMouseUp]);

  // Default label renderer
  const defaultRenderLabel = (label) => {
    const isDragging = dragState.isDragging && dragState.draggedLabelId === label.id;

    // Apply temporary visual offset during drag
    let displayX = label.x;
    let displayY = label.y;

    if (isDragging && dragState.currentWorldOffset) {
      displayX += dragState.currentWorldOffset.dx;
      displayY += dragState.currentWorldOffset.dy;
    }

    // Use ref to attach native event listener for mousedown
    const labelRef = React.useRef(null);

    React.useEffect(() => {
      const element = labelRef.current;
      if (!element) return;

      const nativeMouseDownHandler = (e) => {
        // Convert to React-like event object
        const syntheticEvent = {
          ...e,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
          nativeEvent: e,
          clientX: e.clientX,
          clientY: e.clientY,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey
        };
        handleMouseDown(syntheticEvent, label);
      };

      element.addEventListener('mousedown', nativeMouseDownHandler);
      return () => {
        element.removeEventListener('mousedown', nativeMouseDownHandler);
      };
    }, [label]);

    return (
      <foreignObject
        key={label.id}
        x={displayX}
        y={displayY}
        width={1}
        height={1}
        style={{
          overflow: 'visible',
          pointerEvents: 'auto'
        }}
      >
        <div
          ref={labelRef}
          xmlns="http://www.w3.org/1999/xhtml"
          className={`region-label ${label.active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${className}`}
          onClick={(e) => {
            e.stopPropagation();
            if (onLabelClick && !isDragging) {
              onLabelClick(label);
            }
          }}
          onMouseEnter={() => onLabelHover && onLabelHover(label)}
          onMouseLeave={() => onLabelLeave && onLabelLeave()}
          style={{
            position: 'absolute',
            transform: 'translate(-50%, -50%)',
            padding: '4px 8px',
            fontSize: '12px',
            fontWeight: 500,
            cursor: dragEnabled && dragModifierKey ? 'grab' : 'pointer',
            userSelect: 'none',
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
            opacity: isDragging ? 0.7 : 1,
            whiteSpace: 'nowrap'
          }}
        >
          {label.content}
        </div>
      </foreignObject>
    );
  };

  // Wrapper for custom renderer that provides event handlers
  const renderLabelWithHandlers = (label) => {
    const isDragging = dragState.isDragging && dragState.draggedLabelId === label.id;

    // Apply temporary visual offset during drag
    let displayX = label.x;
    let displayY = label.y;

    if (isDragging && dragState.currentWorldOffset) {
      displayX += dragState.currentWorldOffset.dx;
      displayY += dragState.currentWorldOffset.dy;
    }

    // Event handlers to pass to custom renderer
    const handlers = {
      onMouseDown: (e) => handleMouseDown(e, label),
      onClick: (e) => {
        e.stopPropagation();
        if (onLabelClick && !isDragging) {
          onLabelClick(label);
        }
      },
      onMouseEnter: () => onLabelHover && onLabelHover(label),
      onMouseLeave: () => onLabelLeave && onLabelLeave()
    };

    // Additional props for custom renderer
    const renderProps = {
      isDragging,
      displayX,
      displayY,
      handlers,
      className: `region-label ${label.active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${className}`
    };

    // Use custom renderer if provided, otherwise use default
    if (renderLabel) {
      return renderLabel(label, renderProps);
    }

    return defaultRenderLabel(label);
  };

  if (!labels || labels.length === 0) return null;

  return (
    <g
      ref={svgRef}
      className="region-labels"
      style={{ pointerEvents: 'none' }} // Container doesn't capture events, only foreignObjects do
    >
      {labels.map(renderLabelWithHandlers)}
    </g>
  );
};

export default RegionLabels;
