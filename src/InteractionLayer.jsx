import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { getDotSize, getSyncedInteractionPosition, updateDotAttributes } from './dotUtils.js';

const InteractionLayer = React.memo((props) => {
  const {
    data = [],
    dotId,
    onHover,
    onLeave,
    onClick,
    onBackgroundClick,
    onDragStart,
    isZooming = false,
    defaultSize = 2,
    dotStyles = new Map(),
    hoveredDotId = null,
    hoverSizeEnabled = false,
    hoverSizeMultiplier = 1.5
  } = props;
  
  const interactionLayerRef = useRef(null);
  const [dragState, setDragState] = useState(null);

  // Constants for click vs drag detection
  const DRAG_THRESHOLD = 5; // pixels
  const CLICK_TIME_THRESHOLD = 300; // milliseconds

  const getSize = (item) => {
    const baseSize = getDotSize(item, dotStyles, defaultSize);
    if (hoverSizeEnabled && hoveredDotId === item.id) {
      return baseSize * hoverSizeMultiplier;
    }
    return baseSize;
  };

  const handleMouseEnter = (e, item) => {
    if (!isZooming && onHover) {
      onHover(item, e);
    } else if (isZooming) {
      console.log('❌ Hover blocked - isDragging:', isZooming);
    }
  };

  const handleMouseLeave = (e, item) => {
    if (!isZooming && onLeave) {
      onLeave(item, e);
    }
  };

  const handleMouseDown = (e, item) => {
    const startTime = Date.now();
    const startX = e.clientX;
    const startY = e.clientY;
    
    setDragState({
      item,
      startTime,
      startX,
      startY,
      hasMoved: false
    });
    
    // Don't prevent default here - let the event bubble up for panning
  };

  const handleMouseMove = (e) => {
    if (!dragState) return;
    
    const deltaX = Math.abs(e.clientX - dragState.startX);
    const deltaY = Math.abs(e.clientY - dragState.startY);
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    if (distance > DRAG_THRESHOLD) {
      setDragState(prev => prev ? { ...prev, hasMoved: true } : null);
    }
  };

  const handleMouseUp = (e, item) => {
    if (!dragState) return;
    
    const timeDelta = Date.now() - dragState.startTime;
    const deltaX = Math.abs(e.clientX - dragState.startX);
    const deltaY = Math.abs(e.clientY - dragState.startY);
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    // Consider it a click if:
    // 1. Mouse didn't move much AND
    // 2. Time was short (to distinguish from long press)
    const isClick = distance <= DRAG_THRESHOLD && timeDelta <= CLICK_TIME_THRESHOLD;
    
    if (isClick && onClick && dragState.item.id === item.id) {
      onClick(item, e);
    }
    
    setDragState(null);
  };

  const handleBackgroundClick = (e) => {
    if (onBackgroundClick) {
      onBackgroundClick(e);
    }
  };

  const handleLayerMouseLeave = (e) => {
    // Clear any hover state when mouse leaves the entire visualization area
    if (onLeave) {
      onLeave(null, e);
    }
  };

  const handleDragStart = (e, item) => {
    if (onDragStart) {
      onDragStart(item, e);
    }
  };

  // Apply custom styles to interaction layer dots
  useEffect(() => {
    data.forEach((item) => {
      const elementId = dotId(1, item);
      const position = getSyncedInteractionPosition(item, dotId);
      const size = getSize(item);
      
      updateDotAttributes(item, elementId, position, size);
    });
  }, [data, dotStyles, dotId, hoveredDotId, hoverSizeEnabled, hoverSizeMultiplier]);

  // Global mouse event listeners for drag detection
  useEffect(() => {
    const handleGlobalMouseMove = (e) => handleMouseMove(e);
    const handleGlobalMouseUp = () => setDragState(null);

    if (dragState) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [dragState]);

  // Set up D3 drag behavior for SVG circles
  useEffect(() => {
    if (!onDragStart || !interactionLayerRef.current) return;

    const drag = d3.drag()
      .clickDistance(DRAG_THRESHOLD) // Only consider it a drag if moved more than threshold
      .on('start', function(event, d) {
        console.log('🔴 D3 drag start', d);
        
        // Store drag data globally so HTML5 drop targets can access it
        window._currentDragData = {};
        
        // Create a synthetic drag event with dataTransfer-like functionality
        const syntheticEvent = {
          ...event.sourceEvent,
          dataTransfer: {
            setData: (type, data) => {
              window._currentDragData[type] = data;
              console.log('🔴 Setting drag data:', type, data);
            },
            getData: (type) => window._currentDragData[type],
            types: Object.keys(window._currentDragData || {}),
            effectAllowed: 'copy'
          },
          preventDefault: () => event.sourceEvent.preventDefault(),
          stopPropagation: () => event.sourceEvent.stopPropagation()
        };
        
        // Call the original onDragStart callback
        onDragStart(d, syntheticEvent);
        
        // Set cursor to grabbing and add visual feedback
        d3.select(this)
          .style('cursor', 'grabbing')
          .style('opacity', 0.7)
          .style('stroke', '#007AFF')
          .style('stroke-width', '2px');
      })
      .on('drag', function(event, d) {
        // Simulate HTML5 dragover events on elements under the mouse
        const elementUnderMouse = document.elementFromPoint(event.sourceEvent.clientX, event.sourceEvent.clientY);
        if (elementUnderMouse && window._currentDragData) {
          // Create a synthetic dragover event
          const syntheticDragOver = new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: event.sourceEvent.clientX,
            clientY: event.sourceEvent.clientY,
            dataTransfer: new DataTransfer()
          });
          
          // Manually set the dataTransfer types (read-only property)
          Object.defineProperty(syntheticDragOver.dataTransfer, 'types', {
            value: Object.keys(window._currentDragData),
            writable: false
          });
          
          elementUnderMouse.dispatchEvent(syntheticDragOver);
        }
      })
      .on('end', function(event, d) {
        console.log('🔴 D3 drag end');
        
        // Simulate HTML5 drop event if we're over a valid drop target
        const elementUnderMouse = document.elementFromPoint(event.sourceEvent.clientX, event.sourceEvent.clientY);
        if (elementUnderMouse && window._currentDragData) {
          // Create a synthetic drop event
          const syntheticDrop = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            clientX: event.sourceEvent.clientX,
            clientY: event.sourceEvent.clientY,
            dataTransfer: new DataTransfer()
          });
          
          // Add our data to the dataTransfer
          Object.entries(window._currentDragData).forEach(([type, data]) => {
            try {
              syntheticDrop.dataTransfer.setData(type, data);
            } catch (e) {
              // Some browsers restrict setData on synthetic events
              console.warn('Could not set drag data:', e);
            }
          });
          
          // Override getData to return our data
          const originalGetData = syntheticDrop.dataTransfer.getData.bind(syntheticDrop.dataTransfer);
          syntheticDrop.dataTransfer.getData = (type) => {
            return window._currentDragData[type] || originalGetData(type);
          };
          
          // Manually set the types property
          Object.defineProperty(syntheticDrop.dataTransfer, 'types', {
            value: Object.keys(window._currentDragData),
            writable: false
          });
          
          elementUnderMouse.dispatchEvent(syntheticDrop);
        }
        
        // Clean up
        window._currentDragData = null;
        
        // Reset cursor and visual feedback
        d3.select(this)
          .style('cursor', onDragStart ? 'grab' : (onClick ? 'pointer' : 'default'))
          .style('opacity', null)
          .style('stroke', null)
          .style('stroke-width', null);
      });

    // Apply drag behavior to each circle individually
    data.forEach((item) => {
      const circleId = dotId(1, item);
      const circleElement = d3.select(`#${circleId}`);
      if (!circleElement.empty()) {
        // Bind the item data to this specific element and apply drag
        circleElement.datum(item).call(drag);
      }
    });

  }, [onDragStart, data, dotId, onClick]);

  return (
    <g id="interaction-layer" ref={interactionLayerRef} onMouseLeave={handleLayerMouseLeave}>
      {/* Background rect moved to DotVisualization root to avoid zoom transform issues */}
      {data.map((item) => {
        // Get synchronized position to match ColoredDots
        const { x, y } = getSyncedInteractionPosition(item, dotId);
        
        return (
          <circle
            id={dotId(1, item)}
            key={dotId(1, item)}
            r={getSize(item)}
            cx={x}
            cy={y}
            fill="transparent"
            style={{ cursor: onDragStart ? 'grab' : (onClick ? 'pointer' : 'default') }}
            onClick={!onDragStart && onClick ? (e) => onClick(item, e) : undefined}
            onMouseDown={onDragStart ? (e) => handleMouseDown(e, item) : undefined}
            onMouseUp={onDragStart ? (e) => handleMouseUp(e, item) : undefined}
            onMouseEnter={(e) => handleMouseEnter(e, item)}
            onMouseLeave={(e) => handleMouseLeave(e, item)}
          />
        );
      })}
    </g>
  );
});

export default InteractionLayer;