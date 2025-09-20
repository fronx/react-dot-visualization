import * as d3 from 'd3';

export function decollisioning(data, onUpdatePositions, fnDotSize, onDecollisionComplete) {
  const nodes = data.map(d => ({ ...d }));
  console.log('🔴 Starting decollisioning simulation with', nodes.length, 'nodes');

  let tickCount = 0;
  const simulation = d3.forceSimulation(nodes)
    .alpha(1)
    .alphaMin(0.01)
    .alphaDecay(0.05)  // Faster convergence: ~90 ticks instead of 459
    .force('collide', d3.forceCollide().radius(fnDotSize))
    .on('tick', () => {
      tickCount++;
      console.log(`🟡 Simulation tick ${tickCount}, alpha: ${simulation.alpha().toFixed(3)}`);
      // Create new array reference so React knows the data changed
      onUpdatePositions([...nodes]);
    })
    .on('end', () => {
      console.log(`🟢 Simulation ended after ${tickCount} ticks`);
      onUpdatePositions([...nodes]);

      if (onDecollisionComplete) {
        onDecollisionComplete();
      }
    });

  return simulation;
}
