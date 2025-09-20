# renderDots

- works for canvas and svg already
- so I don't see why we'd need a different renderDotsWithData function for decollisioning

questions
- how does renderDots get its data?
  - `data.forEach...`
  - so it goes straight to the source
    - why not `processedData`?
      - ah, it's the same thing in `ColoredDots`
- how can we animate x, y positions?
  - without rerendering, mind you

# simulations / animations

- position transition in `DotVisualization`

---

# What I've learned / que/stions

- once decollision simulation is defined, it runs in the background, ticking continuously
- setProcessedData is very fast
- why are all the node sizes different?
- do we still need memoizedPositions?
- 