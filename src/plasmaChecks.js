/**
 * plasmaChecks.js — Plasma sanity checks for DXF geometry.
 *
 * Detects:
 *   - Open contours (parts that won't drop out)
 *   - Duplicate/overlapping entities (double cuts)
 *   - Tiny gaps between endpoints (incomplete cuts)
 *   - Inside vs outside loop classification
 */

const SNAP_TOL = 0.01;     // endpoints within this are "connected"
const GAP_TOL = 0.15;      // gaps between SNAP_TOL and this are "tiny gaps"
const DUP_TOL = 0.01;      // tolerance for duplicate detection

function dist(a, b) {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

// ─── Endpoint extraction ────────────────────────────────────────────────────────

function getEndpoints(g) {
  switch (g.type) {
    case 'line':
    case 'spline':
      return { start: { x: g.points[0].x, y: g.points[0].y }, end: { x: g.points[g.points.length - 1].x, y: g.points[g.points.length - 1].y } };
    case 'polyline':
      return {
        start: { x: g.points[0].x, y: g.points[0].y },
        end: { x: g.points[g.points.length - 1].x, y: g.points[g.points.length - 1].y },
      };
    case 'circle':
      return null; // always closed
    case 'arc':
      return {
        start: { x: g.cx + g.r * Math.cos(g.startAngle), y: g.cy + g.r * Math.sin(g.startAngle) },
        end: { x: g.cx + g.r * Math.cos(g.endAngle), y: g.cy + g.r * Math.sin(g.endAngle) },
      };
    default:
      return null;
  }
}

function isSelfClosed(g) {
  if (g.type === 'circle') return true;
  const ep = getEndpoints(g);
  if (!ep) return true;
  return dist(ep.start, ep.end) < SNAP_TOL;
}

// ─── Chain building — connect entities by endpoints ─────────────────────────────

function buildChains(geometry) {
  const eps = geometry.map((g, i) => ({
    idx: i,
    ep: getEndpoints(g),
    closed: isSelfClosed(g),
  }));

  const used = new Set();
  const chains = [];

  // Self-closed entities are their own chains
  for (const e of eps) {
    if (e.closed) {
      chains.push({ indices: [e.idx], closed: true });
      used.add(e.idx);
    }
  }

  // Chain remaining entities by endpoint matching
  for (let s = 0; s < eps.length; s++) {
    if (used.has(s) || !eps[s].ep) continue;

    const chain = [s];
    used.add(s);
    let chainStart = eps[s].ep.start;
    let chainEnd = eps[s].ep.end;

    let found = true;
    while (found) {
      found = false;
      for (let k = 0; k < eps.length; k++) {
        if (used.has(k) || !eps[k].ep) continue;
        const ep = eps[k].ep;

        if (dist(ep.start, chainEnd) < SNAP_TOL) {
          chain.push(k); used.add(k); chainEnd = ep.end; found = true; break;
        }
        if (dist(ep.end, chainEnd) < SNAP_TOL) {
          chain.push(k); used.add(k); chainEnd = ep.start; found = true; break;
        }
        if (dist(ep.end, chainStart) < SNAP_TOL) {
          chain.unshift(k); used.add(k); chainStart = ep.start; found = true; break;
        }
        if (dist(ep.start, chainStart) < SNAP_TOL) {
          chain.unshift(k); used.add(k); chainStart = ep.end; found = true; break;
        }
      }
    }

    chains.push({ indices: chain, closed: dist(chainStart, chainEnd) < SNAP_TOL });
  }

  return chains;
}

// ─── Open contour detection ─────────────────────────────────────────────────────

function detectOpenContours(geometry) {
  const chains = buildChains(geometry);
  const issues = [];

  for (const chain of chains) {
    if (chain.closed) continue;

    const firstG = geometry[chain.indices[0]];
    const lastG = geometry[chain.indices[chain.indices.length - 1]];
    const ep1 = getEndpoints(firstG);
    const ep2 = getEndpoints(lastG);

    issues.push({
      type: 'open-contour',
      severity: 'error',
      entityIndices: [...chain.indices],
      message: `Open contour (${chain.indices.length} entit${chain.indices.length === 1 ? 'y' : 'ies'}) — part won't drop`,
      points: [ep1?.start, ep2?.end].filter(Boolean),
    });
  }

  return issues;
}

// ─── Duplicate detection ────────────────────────────────────────────────────────

function detectDuplicates(geometry) {
  const issues = [];
  const flagged = new Set();

  for (let i = 0; i < geometry.length; i++) {
    if (flagged.has(i)) continue;
    for (let j = i + 1; j < geometry.length; j++) {
      if (flagged.has(j)) continue;
      if (areDuplicates(geometry[i], geometry[j])) {
        issues.push({
          type: 'duplicate',
          severity: 'warning',
          entityIndices: [i, j],
          message: `Duplicate ${geometry[i].type} — will cause double cut`,
          points: [],
        });
        flagged.add(j);
      }
    }
  }

  return issues;
}

function areDuplicates(a, b) {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case 'line': {
      const fwd = dist(a.points[0], b.points[0]) < DUP_TOL && dist(a.points[1], b.points[1]) < DUP_TOL;
      const rev = dist(a.points[0], b.points[1]) < DUP_TOL && dist(a.points[1], b.points[0]) < DUP_TOL;
      return fwd || rev;
    }
    case 'circle':
      return Math.abs(a.cx - b.cx) < DUP_TOL && Math.abs(a.cy - b.cy) < DUP_TOL && Math.abs(a.r - b.r) < DUP_TOL;
    case 'arc':
      return Math.abs(a.cx - b.cx) < DUP_TOL && Math.abs(a.cy - b.cy) < DUP_TOL &&
        Math.abs(a.r - b.r) < DUP_TOL &&
        Math.abs(a.startAngle - b.startAngle) < 0.01 && Math.abs(a.endAngle - b.endAngle) < 0.01;
    case 'polyline':
    case 'spline': {
      if (a.points.length !== b.points.length) return false;
      let fwd = true, rev = true;
      for (let k = 0; k < a.points.length; k++) {
        if (dist(a.points[k], b.points[k]) > DUP_TOL) fwd = false;
        if (dist(a.points[k], b.points[b.points.length - 1 - k]) > DUP_TOL) rev = false;
        if (!fwd && !rev) return false;
      }
      return fwd || rev;
    }
    default:
      return false;
  }
}

// ─── Tiny gap detection ─────────────────────────────────────────────────────────

function detectTinyGaps(geometry) {
  const endpoints = [];
  for (let i = 0; i < geometry.length; i++) {
    const ep = getEndpoints(geometry[i]);
    if (!ep) continue;
    endpoints.push({ idx: i, point: ep.start, which: 'start' });
    endpoints.push({ idx: i, point: ep.end, which: 'end' });
  }

  const issues = [];
  const seen = new Set();

  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      if (endpoints[i].idx === endpoints[j].idx) continue;
      const d = dist(endpoints[i].point, endpoints[j].point);
      if (d > SNAP_TOL && d < GAP_TOL) {
        const key = [endpoints[i].idx, endpoints[j].idx].sort().join('-');
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          type: 'tiny-gap',
          severity: 'warning',
          entityIndices: [endpoints[i].idx, endpoints[j].idx],
          message: `Tiny gap (${d.toFixed(4)} units) — may cause incomplete cut`,
          points: [endpoints[i].point, endpoints[j].point],
          gapSize: d,
        });
      }
    }
  }

  return issues;
}

// ─── Loop classification (inside / outside) ─────────────────────────────────────

function classifyLoops(geometry) {
  const chains = buildChains(geometry);
  const closedChains = chains.filter(c => c.closed);

  const loops = closedChains.map(chain => {
    const polygon = chainToPolygon(chain, geometry);
    const area = signedArea(polygon);
    return {
      indices: chain.indices,
      polygon,
      area,
      direction: area > 0 ? 'ccw' : 'cw',
      type: 'unknown',
    };
  });

  // Sort by absolute area (largest first) for containment check
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  for (let i = 0; i < loops.length; i++) {
    let containedIn = 0;
    for (let j = 0; j < loops.length; j++) {
      if (i === j) continue;
      if (Math.abs(loops[j].area) <= Math.abs(loops[i].area)) continue;
      if (loops[i].polygon.length > 0 && pointInPolygon(loops[i].polygon[0], loops[j].polygon)) {
        containedIn++;
      }
    }
    loops[i].type = containedIn % 2 === 0 ? 'outside' : 'inside';
  }

  return loops;
}

function chainToPolygon(chain, geometry) {
  const points = [];
  for (const idx of chain.indices) {
    const pts = entityToFlatPoints(geometry[idx]);
    for (let i = 0; i < pts.length; i++) {
      if (i === 0 && points.length > 0 && dist(pts[0], points[points.length - 1]) < SNAP_TOL) continue;
      points.push(pts[i]);
    }
  }
  return points;
}

function entityToFlatPoints(g) {
  switch (g.type) {
    case 'line':
    case 'spline':
      return g.points.map(p => ({ x: p.x, y: p.y }));
    case 'polyline':
      return g.points.map(p => ({ x: p.x, y: p.y }));
    case 'circle': {
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const a = (2 * Math.PI * i) / 64;
        pts.push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
      }
      return pts;
    }
    case 'arc': {
      let sweep = g.endAngle - g.startAngle;
      if (sweep < 0) sweep += 2 * Math.PI;
      const S = Math.max(16, Math.round(sweep / (Math.PI / 32)));
      const pts = [];
      for (let i = 0; i <= S; i++) {
        const a = g.startAngle + sweep * (i / S);
        pts.push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
      }
      return pts;
    }
    default:
      return [];
  }
}

function signedArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    area += polygon[i].x * polygon[j].y;
    area -= polygon[j].x * polygon[i].y;
  }
  return area / 2;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Main entry point ───────────────────────────────────────────────────────────

export function runPlasmaChecks(geometry) {
  const issues = [
    ...detectOpenContours(geometry),
    ...detectDuplicates(geometry),
    ...detectTinyGaps(geometry),
  ];
  const loops = classifyLoops(geometry);
  return { issues, loops };
}
