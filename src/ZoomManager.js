/**
 * ZoomManager - Complete zoom functionality for DotVisualization
 * 
 * Handles:
 * - Interactive zoom/pan with canvas-SVG sync (prevents flicker)
 * - Programmatic zoom animations (auto-zoom, zoomToVisible)
 * - Zoom extent management
 * - Transform state management
 */

import * as d3 from 'd3';
import {
  boundsForData,
  computeFitTransformToVisible,
  shouldAutoZoomToNewContent,
  computeAbsoluteExtent,
  unionExtent,
  setAbsoluteExtent,
  updateZoomExtentForData
} from './utils.js';

/**
 * Classify wheel events into gesture types for intuitive trackpad behavior.
 * - ctrlKey: pinch-to-zoom on trackpad (browser sends ctrlKey + small deltaY)
 * - metaKey/altKey: modifier + scroll = zoom
 * - plain scroll: pan
 */
function classifyWheelGesture(event) {
  if (event.ctrlKey) return 'pinch';
  if (event.metaKey || event.altKey) return 'scroll-zoom';
  return 'scroll-pan';
}

export class ZoomManager {
  constructor(options = {}) {
    // Required references
    this.zoomRef = options.zoomRef;
    this.contentRef = options.contentRef;
    this.canvasRenderer = options.canvasRenderer; // Function to render canvas

    // Configuration
    this.zoomExtent = options.zoomExtent || [0.5, 20];
    this.defaultSize = options.defaultSize || 2;
    this.fitMargin = options.fitMargin || 0.9;
    this.occludeLeft = options.occludeLeft || 0;
    this.occludeRight = options.occludeRight || 0;
    this.occludeTop = options.occludeTop || 0;
    this.occludeBottom = options.occludeBottom || 0;
    this.useCanvas = options.useCanvas || false;

    // State
    this.transform = options.initialTransform
      ? d3.zoomIdentity.translate(options.initialTransform.x, options.initialTransform.y).scale(options.initialTransform.k)
      : d3.zoomIdentity;
    this.zoomHandler = d3.zoom();
    this.baseScaleRef = options.initialTransform ? options.initialTransform.k : 1;
    this.viewBox = null;
    this.lastDataBounds = null;
    this.hasInitialTransform = !!options.initialTransform;
    this.initialTransformApplied = false; // Track if we've already applied initial transform

    // RAF state for coalescing rapid zoom events (prevents flicker)
    this.rafState = { pending: false, lastT: d3.zoomIdentity };

    // Callbacks
    this.onZoomStart = options.onZoomStart;
    this.onZoomEnd = options.onZoomEnd;
    this.onTransformChange = options.onTransformChange;

    this.boundHandleZoom = this.handleZoom.bind(this);
  }

  /**
   * Initialize zoom behavior and bind to DOM element
   */
  initialize() {
    if (!this.zoomRef?.current) return;

    this.zoomHandler
      .on("start", (event) => {
        if (this.onZoomStart) this.onZoomStart(event);
      })
      .on("end", (event) => {
        if (this.onTransformChange) this.onTransformChange();
        if (this.onZoomEnd) this.onZoomEnd(event);
      })
      .on("zoom", this.boundHandleZoom);

    d3.select(this.zoomRef.current).call(this.zoomHandler);

    // Disable d3-zoom's built-in wheel handling — we handle it ourselves
    d3.select(this.zoomRef.current).on('wheel.zoom', null);

    // Custom wheel handler: scroll → pan, pinch/modifier → zoom
    this.boundHandleWheel = this.handleWheel.bind(this);
    this.zoomRef.current.addEventListener('wheel', this.boundHandleWheel, { passive: false });

    // Apply initial transform only once (on first initialization)
    if (this.hasInitialTransform && !this.initialTransformApplied) {
      this.applyTransformViaZoomHandler(this.transform);
      this.initialTransformApplied = true;
    }
  }

  /**
   * Custom wheel handler: scroll-to-pan, pinch/modifier-to-zoom
   */
  handleWheel(event) {
    event.preventDefault();
    event.stopPropagation();

    const gesture = classifyWheelGesture(event);
    const t = this.transform;

    // Convert screen pixels to viewBox units
    const rect = this.zoomRef.current.getBoundingClientRect();
    const vb = this.viewBox || [0, 0, 100, 100];
    const scaleX = vb[2] / rect.width;
    const scaleY = vb[3] / rect.height;

    if (gesture === 'scroll-pan') {
      const newTransform = d3.zoomIdentity
        .translate(t.x - event.deltaX * scaleX, t.y - event.deltaY * scaleY)
        .scale(t.k);
      this.applyTransformViaZoomHandler(newTransform);
    } else {
      // Zoom toward cursor
      const isPinch = gesture === 'pinch';
      const zoomBase = 1.003;
      const multiplier = isPinch ? 3 : 1;
      const factor = Math.pow(zoomBase, -event.deltaY * multiplier);

      const [minScale, maxScale] = this.zoomHandler.scaleExtent();
      const newK = Math.max(minScale, Math.min(maxScale, t.k * factor));
      if (Math.abs(newK - t.k) < 0.001) return;

      // Cursor position in viewBox coordinates
      const cursorX = (event.clientX - rect.left) * scaleX + vb[0];
      const cursorY = (event.clientY - rect.top) * scaleY + vb[1];

      // Zoom-to-point: keep cursor position fixed in screen space
      const ratio = newK / t.k;
      const newTransform = d3.zoomIdentity
        .translate(
          cursorX - ratio * (cursorX - t.x),
          cursorY - ratio * (cursorY - t.y)
        )
        .scale(newK);

      this.applyTransformViaZoomHandler(newTransform);
    }
  }

  /**
   * Handle interactive zoom events with rAF coalescing (prevents flicker)
   */
  handleZoom(event) {
    this.rafState.lastT = event.transform;
    if (this.rafState.pending) return;
    
    this.rafState.pending = true;
    requestAnimationFrame(() => {
      this.rafState.pending = false;
      const t = this.rafState.lastT;
      this.applyTransformSync(t);
      if (this.onTransformChange) this.onTransformChange();
    });
  }

  /**
   * Apply transform to both SVG and canvas synchronously (prevents flicker)
   */
  applyTransformSync(transform) {
    this.transform = transform;
    
    // 1) Update SVG layer
    if (this.contentRef?.current) {
      this.contentRef.current.setAttribute("transform", transform.toString());
    }
    
    // 2) Update canvas layer in SAME frame
    if (this.useCanvas && this.canvasRenderer) {
      this.canvasRenderer(transform);
    }
  }

  /**
   * Apply transform via d3 zoom handler (for programmatic zoom final states)
   */
  applyTransformViaZoomHandler(transform) {
    if (this.zoomRef?.current && this.zoomHandler) {
      d3.select(this.zoomRef.current).call(this.zoomHandler.transform, transform);
      this.transform = transform;
    }
  }

  /**
   * Apply transform directly without triggering zoom handler (for animations)
   */
  applyTransformDirect(transform) {
    if (this.zoomRef?.current) {
      d3.select(this.zoomRef.current).property('__zoom', transform);
    }
    this.applyTransformSync(transform);
  }

  /**
   * Set view box for zoom calculations
   */
  setViewBox(viewBox) {
    this.viewBox = viewBox;
  }

  /**
   * Initialize camera on first data arrival (instant, no animation)
   * This is a comfort-fit that sets the initial view to show all content
   */
  initCamera(data) {
    if (!this.viewBox || !data?.length) {
      return false;
    }

    // Instant camera fit to show initial content
    return this.comfortFit(data, {
      duration: 0,  // Instant!
      updateExtents: true
    });
  }

  /**
   * Gentle camera adjustment that keeps content comfortably in view
   * This is the "comfort-fit" that prevents content from feeling cramped or lost
   */
  async comfortFit(data, options = {}) {
    const {
      duration = 300,
      easing = d3.easeCubicOut,
      updateExtents = false,
      margin = this.fitMargin
    } = options;

    if (!this.zoomRef?.current || !this.viewBox || !data?.length) {
      return false;
    }

    const rect = this.zoomRef.current.getBoundingClientRect();
    const bounds = boundsForData(data, this.defaultSize);
    const fit = computeFitTransformToVisible(bounds, this.viewBox, rect, {
      left: this.occludeLeft,
      right: this.occludeRight,
      top: this.occludeTop,
      bottom: this.occludeBottom
    }, margin);

    if (!fit) return false;

    const next = d3.zoomIdentity.translate(fit.x, fit.y).scale(fit.k);

    if (updateExtents) {
      // Update zoom extents to accommodate this zoom level
      const newAbsExtent = computeAbsoluteExtent(this.zoomExtent, fit.k);
      const oldAbsExtent = this.zoomHandler.scaleExtent();
      const widenedExtent = unionExtent(oldAbsExtent, newAbsExtent);
      setAbsoluteExtent(this.zoomHandler, widenedExtent);
      this.baseScaleRef = fit.k;
    }

    if (duration > 0) {
      await this.animateToTransform(next, { duration, easing });

      if (updateExtents) {
        // Finalize extents after animation
        const finalExtent = computeAbsoluteExtent(this.zoomExtent, this.baseScaleRef);
        setAbsoluteExtent(this.zoomHandler, finalExtent);
      }
    } else {
      // For instant fit, apply transform via zoom handler
      this.applyTransformViaZoomHandler(next);
    }

    return true;
  }

  /**
   * Zoom to fit visible data with animation
   */
  async zoomToVisible(data, options = {}) {
    const {
      duration = 0,
      easing = d3.easeCubicInOut,
      updateExtents = true,
      margin = this.fitMargin
    } = options;

    if (!this.zoomRef?.current || !this.viewBox || !data?.length) {
      return false;
    }

    const rect = this.zoomRef.current.getBoundingClientRect();
    const bounds = boundsForData(data, this.defaultSize);
    const fit = computeFitTransformToVisible(bounds, this.viewBox, rect, {
      left: this.occludeLeft,
      right: this.occludeRight,
      top: this.occludeTop,
      bottom: this.occludeBottom
    }, margin);

    if (!fit) return false;

    const next = d3.zoomIdentity.translate(fit.x, fit.y).scale(fit.k);

    if (updateExtents) {
      // Update zoom extents to accommodate this zoom level
      const newAbsExtent = computeAbsoluteExtent(this.zoomExtent, fit.k);
      const oldAbsExtent = this.zoomHandler.scaleExtent();
      const widenedExtent = unionExtent(oldAbsExtent, newAbsExtent);
      setAbsoluteExtent(this.zoomHandler, widenedExtent);
      this.baseScaleRef = fit.k;
    }

    if (duration > 0) {
      await this.animateToTransform(next, { duration, easing });

      if (updateExtents) {
        // Finalize extents after animation
        const finalExtent = computeAbsoluteExtent(this.zoomExtent, this.baseScaleRef);
        setAbsoluteExtent(this.zoomHandler, finalExtent);
      }
    } else {
      // For instant zoom, apply transform via zoom handler
      this.applyTransformViaZoomHandler(next);
    }

    return true;
  }

  /**
   * Compute the transform needed to fit data into the visible region.
   */
  getFitTransform(data, options = {}) {
    const {
      margin = this.fitMargin
    } = options;

    if (!this.zoomRef?.current || !this.viewBox || !data?.length) {
      return null;
    }

    const rect = this.zoomRef.current.getBoundingClientRect();
    const bounds = boundsForData(data, this.defaultSize);
    const fit = computeFitTransformToVisible(bounds, this.viewBox, rect, {
      left: this.occludeLeft,
      right: this.occludeRight,
      top: this.occludeTop,
      bottom: this.occludeBottom
    }, margin);

    if (!fit) return null;

    return {
      x: fit.x,
      y: fit.y,
      k: fit.k
    };
  }

  /**
   * Initialize zoom on first data arrival (instant, no animation)
   */
  initZoom(newData) {
    if (!this.viewBox || !newData?.length) {
      return false;
    }

    // Skip auto-fit if we have an initial transform from saved state
    if (this.hasInitialTransform) {
      // Just update extents for the current zoom level
      this.updateZoomExtentsForData(newData);
      return true;
    }

    // Instant zoom to fit initial content
    this.zoomToVisible(newData, {
      duration: 0,  // Instant!
      updateExtents: true
    });

    return true;
  }

  /**
   * Check if auto-zoom should trigger and execute it
   */
  checkAutoZoom(newData, options = {}) {
    const {
      autoZoomToNewContent = false,
      autoZoomDuration = 200
    } = options;

    if (!autoZoomToNewContent || !this.viewBox) {
      return false;
    }

    const shouldAutoZoom = shouldAutoZoomToNewContent(
      newData,
      this.lastDataBounds,
      this.viewBox,
      this.transform,
      this.defaultSize
    );

    if (shouldAutoZoom) {
      // First zoom is instant, subsequent zooms are animated
      const isFirstZoom = !this.lastDataBounds;
      const duration = isFirstZoom ? 0 : autoZoomDuration;

      console.log('[ZoomManager] AUTO-ZOOM triggered', { isFirstZoom, duration });
      this.zoomToVisible(newData, {
        duration,
        easing: d3.easeCubicInOut
      });

      // Update bounds after zoom succeeds
      this.updateDataBounds(newData);
      return true;
    }

    return false;
  }

  /**
   * Update data bounds for auto-zoom detection
   */
  updateDataBounds(data) {
    if (data?.length > 0) {
      this.lastDataBounds = boundsForData(data, this.defaultSize);
    } else {
      // Reset bounds when data becomes empty
      // This ensures next dataset gets a clean initial zoom
      this.lastDataBounds = null;
    }
  }

  /**
   * Update zoom extents for new data (when auto-zoom is disabled)
   */
  updateZoomExtentsForData(data) {
    if (!this.viewBox || !data?.length) return;

    const rect = this.zoomRef?.current?.getBoundingClientRect();
    if (!rect) return;

    const occlusion = {
      left: this.occludeLeft,
      right: this.occludeRight,
      top: this.occludeTop,
      bottom: this.occludeBottom
    };

    updateZoomExtentForData(
      this.zoomHandler,
      data,
      this.viewBox,
      rect,
      occlusion,
      this.zoomExtent,
      this.fitMargin,
      this.defaultSize
    );
  }

  /**
   * Animate to a specific transform
   */
  async animateToTransform(targetTransform, options = {}) {
    const {
      duration = 200,
      easing = d3.easeCubicInOut
    } = options;

    if (!this.zoomRef?.current) {
      return Promise.reject(new Error('zoomRef not available'));
    }

    const currentTransform = this.transform;

    // Create interpolators
    const xInterpolator = d3.interpolate(currentTransform.x, targetTransform.x);
    const yInterpolator = d3.interpolate(currentTransform.y, targetTransform.y);
    const kInterpolator = d3.interpolate(currentTransform.k, targetTransform.k);

    return new Promise((resolve) => {
      d3.select(this.zoomRef.current)
        .transition()
        .duration(duration)
        .ease(easing)
        .tween('zoom', () => {
          return (t) => {
            const interpolatedTransform = d3.zoomIdentity
              .translate(xInterpolator(t), yInterpolator(t))
              .scale(kInterpolator(t));
            this.applyTransformDirect(interpolatedTransform);
          };
        })
        .on('end', () => {
          this.applyTransformViaZoomHandler(targetTransform);
          resolve();
        })
        .on('interrupt', () => {
          // Interruptions are expected when animations are superseded by new ones
          // (e.g., rapid arrow key navigation). Resolve silently.
          resolve();
        });
    });
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    Object.assign(this, newConfig);
  }

  /**
   * Get current transform
   */
  getCurrentTransform() {
    return this.transform;
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.zoomHandler) {
      this.zoomHandler.on("start", null).on("end", null).on("zoom", null);
    }
    if (this.zoomRef?.current && this.boundHandleWheel) {
      this.zoomRef.current.removeEventListener('wheel', this.boundHandleWheel);
    }
  }
}
