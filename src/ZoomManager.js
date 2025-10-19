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
    this.transform = d3.zoomIdentity;
    this.zoomHandler = d3.zoom();
    this.baseScaleRef = 1;
    this.viewBox = null;
    this.lastDataBounds = null;
    
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
      this.applyTransformViaZoomHandler(next);
    }

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

    if (!autoZoomToNewContent || !this.viewBox || !this.lastDataBounds) {
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
      this.zoomToVisible(newData, { 
        duration: autoZoomDuration,
        easing: d3.easeCubicInOut 
      });
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
  }
}