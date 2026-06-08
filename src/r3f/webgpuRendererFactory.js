import { WebGPURenderer } from 'three/webgpu';

/**
 * Build the async renderer factory passed to R3F's Canvas `gl` prop.
 *
 * Canvas can ask for `gl` again while the previous async WebGPU renderer is
 * still initializing. The returned function coalesces those calls so one Canvas
 * mount owns exactly one renderer/context. A failed init clears the pending
 * promise so a later Canvas attempt can retry.
 */
export function createSingleFlightWebGpuRendererFactory({
  Renderer = WebGPURenderer,
  rendererOptions = {},
} = {}) {
  let rendererPromise = null;

  return function createWebGpuRenderer(props) {
    if (rendererPromise) return rendererPromise;

    const promise = Promise.resolve().then(async () => {
      const renderer = new Renderer({ ...props, ...rendererOptions });
      await renderer.init();
      return renderer;
    });

    rendererPromise = promise;
    promise.catch(() => {
      if (rendererPromise === promise) rendererPromise = null;
    });

    return promise;
  };
}
