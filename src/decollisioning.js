import * as d3 from 'd3';

export function decollisioning(data, onUpdatePositions, fnDotSize, onDecollisionComplete, skipIntermediateFrames = false, transitionConfig = null) {
  const nodes = data.map(d => ({ ...d }));
  let tickCount = 0;
  const simulation = d3.forceSimulation(nodes)
    .alpha(1)
    .alphaMin(0.01)
    .alphaDecay(0.05)
    // .velocityDecay(0.2)
    .force('collide', d3.forceCollide().radius(fnDotSize))
    .on('tick', () => {
      tickCount++;
      // For incremental updates, skip intermediate frames - only render the final result
      if (!skipIntermediateFrames) {
        // Create new array reference so React knows the data changed
        onUpdatePositions([...nodes]);
      }
    })
    .on('end', () => {
      // For incremental updates with transition, animate from stable to final positions
      if (skipIntermediateFrames && transitionConfig?.enabled && transitionConfig?.stablePositions) {
        startTransition(nodes, transitionConfig, onUpdatePositions, onDecollisionComplete);
      } else {
        // Immediate update for full renders or when transitions disabled
        onUpdatePositions([...nodes]);
        if (onDecollisionComplete) {
          onDecollisionComplete([...nodes]);
        }
      }
    });

  return simulation;
}

function startTransition(targetNodes, config, onUpdatePositions, onDecollisionComplete) {
  const { stablePositions, duration, easing } = config;

  // Create a map of stable positions by id for fast lookup
  const stableMap = new Map(stablePositions.map(node => [node.id, node]));

  // Build transition nodes with start (stable) and end (target) positions
  const transitionNodes = targetNodes.map(target => {
    const stable = stableMap.get(target.id);
    return {
      ...target,
      // Store both positions - we'll interpolate between them
      _startX: stable ? stable.x : target.x,
      _startY: stable ? stable.y : target.y,
      _targetX: target.x,
      _targetY: target.y,
    };
  });

  // D3 timer for smooth animation (more reliable than requestAnimationFrame)
  const timer = d3.timer((elapsed) => {
    const t = Math.min(elapsed / duration, 1); // Progress from 0 to 1
    const easedT = easing ? easing(t) : t;

    // Interpolate positions
    transitionNodes.forEach(node => {
      node.x = node._startX + (node._targetX - node._startX) * easedT;
      node.y = node._startY + (node._targetY - node._startY) * easedT;
    });

    // Update positions on each frame
    onUpdatePositions([...transitionNodes]);

    // Complete when we reach t=1
    if (t >= 1) {
      timer.stop();

      // Clean up transition props and set final positions
      const finalNodes = transitionNodes.map(node => {
        const { _startX, _startY, _targetX, _targetY, ...clean } = node;
        return { ...clean, x: node._targetX, y: node._targetY };
      });

      onUpdatePositions(finalNodes);
      if (onDecollisionComplete) {
        onDecollisionComplete(finalNodes);
      }
    }
  });

  return timer;
}
