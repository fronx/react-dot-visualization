import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DotVisualization from './src/DotVisualization.jsx';

/*
 * Claude Opus 4.8 release celebration 🎉
 *
 * A tiny party built entirely out of the library's own dots:
 *   1. dots fly in from the edges and settle into the glyphs "4.8"
 *   2. hit "Celebrate" (or wait — it auto-fires once) and they explode
 *      into a confetti burst with real velocity + gravity, then
 *      gracefully reassemble back into "4.8".
 *
 * Collision detection is turned off so positions are driven frame-by-frame,
 * and four transparent corner anchors pin the viewBox so the burst never
 * makes the camera jump.
 */

// ---------------------------------------------------------------------------
// Fixed coordinate space. Corner anchors keep the auto-computed viewBox steady.
// ---------------------------------------------------------------------------
const W = 1000;
const H = 440;
const CX = W / 2;
const CY = H / 2;
const PAD = 12;

// 5x7 dot-matrix font, just the glyphs we need to throw this party.
const FONT = {
  '4': [
    '00010',
    '00110',
    '01010',
    '10010',
    '11111',
    '00010',
    '00010',
  ],
  '8': [
    '01110',
    '10001',
    '10001',
    '01110',
    '10001',
    '10001',
    '01110',
  ],
  '.': [
    '00000',
    '00000',
    '00000',
    '00000',
    '00000',
    '01100',
    '01100',
  ],
};

// Per-glyph advance width (in cells). The dot is narrower than the digits.
const ADVANCE = { '4': 5, '8': 5, '.': 3 };
const TEXT = '4.8';
const CELL = 42;            // size of one font cell
const SUBDIV = 2;           // sub-dots per cell axis -> SUBDIV^2 dots per cell
const CHAR_GAP = 1;         // cells of space between characters
const DOT_SIZE = 9;

const CONFETTI_PALETTE = [
  '#ff3b6b', '#ff8a3d', '#ffd23d', '#5ad860',
  '#3dc9ff', '#8a6bff', '#ff5edb', '#ffffff',
];

// Festive warm gradient for the resting glyph, by horizontal position.
function glyphColor(xFrac) {
  const hue = 42 + 300 * xFrac; // gold -> magenta sweep
  return `hsl(${hue.toFixed(0)}, 95%, 60%)`;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// ---------------------------------------------------------------------------
// Build the home (formation) positions that spell out the text.
// ---------------------------------------------------------------------------
function buildHomePositions() {
  // Total width of the rendered string in cells.
  let totalCells = 0;
  for (let i = 0; i < TEXT.length; i++) {
    totalCells += ADVANCE[TEXT[i]];
    if (i < TEXT.length - 1) totalCells += CHAR_GAP;
  }
  const totalWidth = totalCells * CELL;
  const totalHeight = 7 * CELL;
  const originX = CX - totalWidth / 2;
  const originY = CY - totalHeight / 2;

  const dots = [];
  let penCells = 0;

  for (let i = 0; i < TEXT.length; i++) {
    const ch = TEXT[i];
    const grid = FONT[ch];
    const charX = originX + penCells * CELL;

    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        if (grid[r][c] !== '1') continue;
        // Split each lit cell into a SUBDIV x SUBDIV cluster of dots.
        for (let sx = 0; sx < SUBDIV; sx++) {
          for (let sy = 0; sy < SUBDIV; sy++) {
            const x = charX + c * CELL + (sx + 0.5) * (CELL / SUBDIV);
            const y = originY + r * CELL + (sy + 0.5) * (CELL / SUBDIV);
            dots.push({ hx: x, hy: y });
          }
        }
      }
    }
    penCells += ADVANCE[ch] + CHAR_GAP;
  }

  // Color the resting glyph by horizontal position across the whole string.
  const minX = Math.min(...dots.map((d) => d.hx));
  const maxX = Math.max(...dots.map((d) => d.hx));
  dots.forEach((d) => {
    const frac = (d.hx - minX) / (maxX - minX || 1);
    d.baseColor = glyphColor(frac);
  });

  return dots;
}

// ---------------------------------------------------------------------------
// Build the full particle set: glyph dots + transparent corner anchors.
// ---------------------------------------------------------------------------
function buildParticles() {
  const home = buildHomePositions();
  const particles = home.map((d, i) => ({
    id: i,
    isAnchor: false,
    hx: d.hx,
    hy: d.hy,
    // start scattered off the edges so the first formation flies in
    sx: rand(-W * 0.2, W * 1.2),
    sy: Math.random() < 0.5 ? rand(-H, -10) : rand(H + 10, 2 * H),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    size: DOT_SIZE,
    baseColor: d.baseColor,
    confettiColor: CONFETTI_PALETTE[i % CONFETTI_PALETTE.length],
    wobblePhase: rand(0, Math.PI * 2),
    wobbleAmp: rand(0.6, 2.2),
  }));

  // Invisible corner anchors keep the computed viewBox rock-steady.
  const corners = [
    [PAD, PAD], [W - PAD, PAD], [PAD, H - PAD], [W - PAD, H - PAD],
  ];
  corners.forEach(([x, y], k) => {
    particles.push({
      id: `anchor-${k}`,
      isAnchor: true,
      hx: x, hy: y, sx: x, sy: y, x, y, vx: 0, vy: 0,
      size: 0,
      baseColor: 'transparent',
      confettiColor: 'transparent',
      wobblePhase: 0,
      wobbleAmp: 0,
    });
  });

  return particles;
}

// Phase durations (ms)
const FORM_MS = 1300;
const BURST_MS = 1700;
const RETURN_MS = 1200;

const App = () => {
  const particlesRef = useRef(buildParticles());
  const [dots, setDots] = useState(() => snapshot(particlesRef.current, 0));
  const [phase, setPhase] = useState('forming');
  const [burstCount, setBurstCount] = useState(0);

  const phaseRef = useRef('forming');
  const phaseStartRef = useRef(performance.now());
  const lastTsRef = useRef(performance.now());
  const autoFiredRef = useRef(false);

  // Snapshot the particle array into the plain {id,x,y,color,size} the
  // DotVisualization component expects.
  function snapshot(particles, _t) {
    return particles.map((p) => ({
      id: p.id,
      x: p.x ?? p.hx,
      y: p.y ?? p.hy,
      size: p.size,
      color: p.isAnchor ? 'transparent' : p.color || p.baseColor,
      name: p.isAnchor ? null : 'Opus 4.8',
    }));
  }

  function setPhaseTo(next) {
    phaseRef.current = next;
    phaseStartRef.current = performance.now();
    setPhase(next);
  }

  function triggerBurst() {
    if (phaseRef.current === 'bursting') return;
    const particles = particlesRef.current;
    particles.forEach((p) => {
      if (p.isAnchor) return;
      // Explode outward from the centre, with a generous upward kick.
      const dx = (p.x ?? p.hx) - CX;
      const dy = (p.y ?? p.hy) - CY;
      const dist = Math.hypot(dx, dy) || 1;
      const speed = rand(2.4, 4.6);
      p.vx = (dx / dist) * speed * rand(0.6, 1.4) + rand(-1.2, 1.2);
      p.vy = (dy / dist) * speed * rand(0.4, 1.0) - rand(2.5, 5.5);
      p.color = p.confettiColor;
    });
    setBurstCount((n) => n + 1);
    setPhaseTo('bursting');
  }

  useEffect(() => {
    let raf;
    const tick = (ts) => {
      const particles = particlesRef.current;
      const phaseNow = phaseRef.current;
      const elapsed = ts - phaseStartRef.current;
      const dtRaw = ts - lastTsRef.current;
      lastTsRef.current = ts;
      const dt = Math.min(dtRaw, 40) / 16.67; // normalise to ~60fps steps

      if (phaseNow === 'forming') {
        const t = Math.min(elapsed / FORM_MS, 1);
        const e = easeOutCubic(t);
        particles.forEach((p) => {
          if (p.isAnchor) return;
          p.x = p.sx + (p.hx - p.sx) * e;
          p.y = p.sy + (p.hy - p.sy) * e;
          p.color = p.baseColor;
        });
        if (t >= 1) setPhaseTo('idle');
      } else if (phaseNow === 'idle') {
        // Gentle floating wobble so the glyph feels alive.
        const time = ts / 1000;
        particles.forEach((p) => {
          if (p.isAnchor) return;
          p.x = p.hx + Math.sin(time * 1.6 + p.wobblePhase) * p.wobbleAmp;
          p.y = p.hy + Math.cos(time * 1.3 + p.wobblePhase) * p.wobbleAmp;
          p.color = p.baseColor;
        });
        // Auto-fire the party once so an idle viewer still sees confetti.
        if (!autoFiredRef.current && elapsed > 1400) {
          autoFiredRef.current = true;
          triggerBurst();
        }
      } else if (phaseNow === 'bursting') {
        const gravity = 0.14;
        particles.forEach((p) => {
          if (p.isAnchor) return;
          p.vy += gravity * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          // Bounce softly off the floor and walls so confetti stays on screen.
          if (p.y > H - PAD) { p.y = H - PAD; p.vy *= -0.45; p.vx *= 0.7; }
          if (p.y < PAD) { p.y = PAD; p.vy *= -0.4; }
          if (p.x < PAD) { p.x = PAD; p.vx *= -0.5; }
          if (p.x > W - PAD) { p.x = W - PAD; p.vx *= -0.5; }
          p.color = p.confettiColor;
        });
        if (elapsed >= BURST_MS) {
          // Remember where everyone landed, to ease back home from there.
          particles.forEach((p) => {
            if (p.isAnchor) return;
            p.rx = p.x; p.ry = p.y;
          });
          setPhaseTo('returning');
        }
      } else if (phaseNow === 'returning') {
        const t = Math.min(elapsed / RETURN_MS, 1);
        const e = easeInOutCubic(t);
        particles.forEach((p) => {
          if (p.isAnchor) return;
          p.x = p.rx + (p.hx - p.rx) * e;
          p.y = p.ry + (p.hy - p.ry) * e;
          // Fade confetti colors back to the glyph palette as they arrive.
          p.color = t > 0.7 ? p.baseColor : p.confettiColor;
        });
        if (t >= 1) setPhaseTo('idle');
      }

      setDots(snapshot(particles, ts));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phaseLabel = {
    forming: 'forming…',
    idle: 'ready',
    bursting: 'celebrating! 🎉',
    returning: 'reassembling…',
  }[phase];

  return (
    <div className="party">
      <header>
        <h1>Claude Opus 4.8</h1>
        <p className="tagline">
          built out of nothing but dots — happy release day
        </p>
      </header>

      <div className="stage">
        <DotVisualization
          data={dots}
          enableDecollisioning={false}
          margin={0.04}
          defaultSize={DOT_SIZE}
          dotStroke="none"
          dotStrokeWidth={0}
          zoomExtent={[0.7, 6]}
        />
      </div>

      <div className="controls">
        <button onClick={triggerBurst} disabled={phase === 'bursting'}>
          🎉 Celebrate 4.8
        </button>
        <span className="status">
          {phaseLabel} · {burstCount} burst{burstCount === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root'));
root.render(<App />);
