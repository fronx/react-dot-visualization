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
      // R3F awaits this factory before connecting its event manager. A keyed
      // Canvas can unmount during WebGPU init; R3F 9.6 otherwise resumes with a
      // cleared host ref and throws while connecting events to `null`, while
      // also mounting a renderer root nobody can dispose. Dispose our renderer
      // and leave that abandoned configure promise pending. The factory belongs
      // to the unmounted DotVisualizationR3F instance, so no live caller waits
      // on it and the detached root can be collected without a zombie mount.
      if (props.canvas?.isConnected === false) {
        renderer.dispose?.();
        return new Promise(() => {});
      }
      return renderer;
    });

    rendererPromise = promise;
    promise.catch(() => {
      if (rendererPromise === promise) rendererPromise = null;
    });

    return promise;
  };
}
