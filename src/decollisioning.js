import * as d3 from 'd3';

export function decollisioning(data, onUpdatePositions, fnDotSize, onDecollisionComplete) {
  const nodes = data.map(d => ({ ...d }));

  let tickCount = 0;
  const simulation = d3.forceSimulation(nodes)
    .alpha(1)
    .alphaMin(0.01)
    .alphaDecay(0.05)  // Faster convergence: ~90 ticks instead of 459
    .force('collide', d3.forceCollide().radius(fnDotSize))
    .on('tick', () => {
      tickCount++;
      // Create new array reference so React knows the data changed
      onUpdatePositions([...nodes]);
    })
    .on('end', () => {
      onUpdatePositions([...nodes]);

      if (onDecollisionComplete) {
        onDecollisionComplete();
      }
    });

  return simulation;
}
