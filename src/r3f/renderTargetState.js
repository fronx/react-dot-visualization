/**
 * Run an offscreen pass without leaving renderer state behind for the visible
 * canvas pass. WebGPU renderer state leaks here are hard to diagnose because
 * they can look like a blank or over-bright map on the next frame.
 */
export function withTemporaryRenderTarget(
  gl,
  target,
  previousClearColor,
  render,
  { clearColor = 0x000000, clearAlpha = 0 } = {},
) {
  const previousTarget = gl.getRenderTarget();
  const previousClearAlpha = gl.getClearAlpha();
  gl.getClearColor(previousClearColor);

  try {
    gl.setRenderTarget(target);
    gl.setClearColor(clearColor, clearAlpha);
    return render();
  } finally {
    gl.setRenderTarget(previousTarget);
    gl.setClearColor(previousClearColor, previousClearAlpha);
  }
}
