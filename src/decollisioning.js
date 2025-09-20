import * as d3 from 'd3';

export function decollisioning(data, onUpdatePositions, fnDotSize, onDecollisionComplete) {
  const nodes = data.map(d => ({ ...d }));
  console.log('Decolliding dots', nodes);
  const simulation = d3.forceSimulation(nodes)
    .alpha(1)
    .alphaMin(0.01)
    .alphaDecay(0.01)
    .force('collide', d3.forceCollide().radius(fnDotSize))
    .on('tick', () => {
      onUpdatePositions(nodes);
    })
    .on('end', () => {
      onUpdatePositions(nodes);

      if (onDecollisionComplete) {
        onDecollisionComplete();
      }
    });

  return simulation;
}
