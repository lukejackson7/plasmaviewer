/**
 * dxfHelpers.js — Parse DXF entities into a normalized format and compute metrics.
 *
 * Coordinate convention:
 *   DXF uses Y-up. Canvas uses Y-down.
 *   We store world coords as-is (Y-up) and flip Y in the transform pipeline at render time.
 */

import DxfParser from 'dxf-parser';

// ─── Parse DXF text into structured entity list ────────────────────────────────

export function parseDxfText(text) {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  if (!dxf || !dxf.entities) return { entities: [], raw: dxf };
  return { entities: dxf.entities, raw: dxf };
}

// ─── Extract drawable geometry from each entity ─────────────────────────────────

/**
 * Returns an array of normalized draw commands:
 *   { type: 'line', points: [{x,y}, ...] }
 *   { type: 'polyline', points: [{x,y,bulge}, ...] }
 *   { type: 'circle', cx, cy, r }
 *   { type: 'arc', cx, cy, r, startAngle, endAngle }  (radians, CCW)
 *   { type: 'spline', points: [{x,y}, ...] }  (tessellated to line segments)
 */
export function extractGeometry(entities) {
  const geo = [];

  for (const e of entities) {
    try {
      switch (e.type) {
        case 'LINE':
          if (e.vertices && e.vertices.length >= 2) {
            geo.push({ type: 'line', points: e.vertices.map(v => ({ x: v.x, y: v.y })) });
          }
          break;

        case 'LWPOLYLINE':
        case 'POLYLINE': {
          const verts = e.vertices;
          if (!verts || verts.length < 2) break;
          const pts = verts.map(v => ({ x: v.x, y: v.y, bulge: v.bulge || 0 }));
          if (e.shape || e.closed) {
            pts.push({ ...pts[0], bulge: 0 });
          }
          geo.push({ type: 'polyline', points: pts });
          break;
        }

        case 'CIRCLE':
          geo.push({
            type: 'circle',
            cx: e.center.x,
            cy: e.center.y,
            r: e.radius,
          });
          break;

        case 'ARC': {
          const startAngle = (e.startAngle * Math.PI) / 180;
          const endAngle = (e.endAngle * Math.PI) / 180;
          geo.push({
            type: 'arc',
            cx: e.center.x,
            cy: e.center.y,
            r: e.radius,
            startAngle,
            endAngle,
          });
          break;
        }

        case 'SPLINE': {
          const pts = tessellateSpline(e);
          if (pts && pts.length >= 2) {
            geo.push({ type: 'spline', points: pts });
          }
          break;
        }

        default:
          break;
      }
    } catch {
      // Skip malformed entities
    }
  }

  return geo;
}

// ─── SPLINE tessellation ────────────────────────────────────────────────────────
//
// Strategy:
//   1. If fitPoints exist, use Catmull-Rom interpolation (smooth curve through each point)
//   2. Else if controlPoints + knotValues exist, evaluate B-spline via De Boor's algorithm
//   3. Fallback: straight lines through controlPoints
//
// Catmull-Rom for 4 points P0..P3, parameter t in [0,1]:
//   q(t) = 0.5 * ((2*P1) + (-P0+P2)*t + (2P0-5P1+4P2-P3)*t² + (-P0+3P1-3P2+P3)*t³)

function tessellateSpline(entity) {
  const fitPts = entity.fitPoints;
  const ctrlPts = entity.controlPoints;
  const knots = entity.knotValues;
  const degree = entity.degreeOfSplineCurve || 3;

  if (fitPts && fitPts.length >= 2) {
    return catmullRomChain(fitPts.map(p => ({ x: p.x, y: p.y })));
  }

  if (ctrlPts && ctrlPts.length >= 2 && knots && knots.length >= ctrlPts.length + degree + 1) {
    return evaluateBSpline(ctrlPts, knots, degree);
  }

  if (ctrlPts && ctrlPts.length >= 2) {
    return ctrlPts.map(p => ({ x: p.x, y: p.y }));
  }

  return null;
}

function catmullRomChain(points) {
  if (points.length < 2) return points;
  if (points.length === 2) return [...points];

  const result = [];
  const SEGS = 16; // segments per span

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    for (let s = 0; s < SEGS; s++) {
      const t = s / SEGS;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  result.push({ ...points[points.length - 1] });
  return result;
}

function evaluateBSpline(ctrlPts, knots, degree) {
  const n = ctrlPts.length;
  const result = [];
  const TOTAL = Math.max(n * 16, 64);
  const tMin = knots[degree];
  const tMax = knots[n];
  if (tMax <= tMin) return ctrlPts.map(p => ({ x: p.x, y: p.y }));

  for (let i = 0; i <= TOTAL; i++) {
    const t = tMin + (tMax - tMin) * (i / TOTAL);
    const pt = deBoor(t, degree, ctrlPts, knots);
    if (pt) result.push(pt);
  }
  return result;
}

/** De Boor's algorithm — evaluate B-spline at parameter t */
function deBoor(t, degree, ctrlPts, knots) {
  const n = ctrlPts.length;
  let k = degree;
  for (let i = degree; i < n; i++) {
    if (t >= knots[i] && t <= knots[i + 1]) { k = i; break; }
  }

  const d = [];
  for (let j = 0; j <= degree; j++) {
    const idx = k - degree + j;
    if (idx < 0 || idx >= n) return null;
    d.push({ x: ctrlPts[idx].x, y: ctrlPts[idx].y });
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const left = k - degree + j;
      const kL = knots[left];
      const kR = knots[left + degree - r + 1];
      const denom = kR - kL;
      if (Math.abs(denom) < 1e-10) continue;
      const alpha = (t - kL) / denom;
      d[j].x = (1 - alpha) * d[j - 1].x + alpha * d[j].x;
      d[j].y = (1 - alpha) * d[j - 1].y + alpha * d[j].y;
    }
  }
  return { x: d[degree].x, y: d[degree].y };
}

// ─── Compute bounding box ───────────────────────────────────────────────────────

export function computeBoundingBox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expand = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };

  for (const g of geometry) {
    switch (g.type) {
      case 'line':
      case 'spline':
        g.points.forEach(p => expand(p.x, p.y));
        break;
      case 'polyline':
        g.points.forEach(p => expand(p.x, p.y));
        for (let i = 0; i < g.points.length - 1; i++) {
          if (g.points[i].bulge && g.points[i].bulge !== 0) {
            const bb = bulgeArcBounds(g.points[i], g.points[i + 1], g.points[i].bulge);
            expand(bb.minX, bb.minY); expand(bb.maxX, bb.maxY);
          }
        }
        break;
      case 'circle':
        expand(g.cx - g.r, g.cy - g.r); expand(g.cx + g.r, g.cy + g.r);
        break;
      case 'arc':
        expand(g.cx - g.r, g.cy - g.r); expand(g.cx + g.r, g.cy + g.r);
        break;
    }
  }

  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// ─── Compute total cut length ───────────────────────────────────────────────────

export function computeCutLength(geometry) {
  let total = 0;
  for (const g of geometry) {
    switch (g.type) {
      case 'line': {
        const [a, b] = g.points;
        total += dist(a, b);
        break;
      }
      case 'spline':
        for (let i = 0; i < g.points.length - 1; i++) total += dist(g.points[i], g.points[i + 1]);
        break;
      case 'polyline':
        for (let i = 0; i < g.points.length - 1; i++) {
          const p1 = g.points[i], p2 = g.points[i + 1];
          total += (p1.bulge && p1.bulge !== 0) ? bulgeArcLength(p1, p2, p1.bulge) : dist(p1, p2);
        }
        break;
      case 'circle':
        total += 2 * Math.PI * g.r;
        break;
      case 'arc': {
        let sweep = g.endAngle - g.startAngle;
        if (sweep < 0) sweep += 2 * Math.PI;
        total += g.r * sweep;
        break;
      }
    }
  }
  return total;
}

// ─── Collect vertex nodes ───────────────────────────────────────────────────────

export function collectNodes(geometry) {
  const nodes = [];
  for (const g of geometry) {
    switch (g.type) {
      case 'line':
        g.points.forEach(p => nodes.push(p));
        break;
      case 'polyline':
        g.points.forEach(p => nodes.push({ x: p.x, y: p.y }));
        break;
      case 'spline':
        if (g.points.length > 0) nodes.push(g.points[0]);
        if (g.points.length > 1) nodes.push(g.points[g.points.length - 1]);
        break;
      case 'circle':
        nodes.push({ x: g.cx + g.r, y: g.cy });
        break;
      case 'arc':
        nodes.push({ x: g.cx + g.r * Math.cos(g.startAngle), y: g.cy + g.r * Math.sin(g.startAngle) });
        nodes.push({ x: g.cx + g.r * Math.cos(g.endAngle), y: g.cy + g.r * Math.sin(g.endAngle) });
        break;
    }
  }
  return nodes;
}

// ─── Get start point ────────────────────────────────────────────────────────────

export function getStartPoint(geometry) {
  if (geometry.length === 0) return null;
  const g = geometry[0];
  switch (g.type) {
    case 'line':
    case 'spline':
      return g.points[0];
    case 'polyline':
      return { x: g.points[0].x, y: g.points[0].y };
    case 'circle':
      return { x: g.cx + g.r, y: g.cy };
    case 'arc':
      return { x: g.cx + g.r * Math.cos(g.startAngle), y: g.cy + g.r * Math.sin(g.startAngle) };
    default:
      return null;
  }
}

// ─── Build simulation path ──────────────────────────────────────────────────────
//
// Flatten all geometry into a single polyline with cumulative distances.
// Each point has: { x, y, dist, rapid }
//   rapid=false → cutting move (torch on)
//   rapid=true  → lift/traverse move (torch off, head repositioning)
//
// A rapid is detected when there's a gap between the end of one entity
// and the start of the next (distance > GAP_THRESHOLD).

const GAP_THRESHOLD = 0.5; // units — if gap > this, it's a rapid move

/**
 * @param {Array} geometry
 * @param {Array<number>} [order] - optional list of entity indices (into `geometry`)
 *   specifying the desired cut sequence. Defaults to the natural array order.
 *   Lets callers implement CAM-style cut ordering (e.g. inside contours first).
 */
export function buildSimulationPath(geometry, order) {
  const path = [];
  const sequence = (order && order.length) ? order : geometry.map((_, i) => i);

  for (const gIdx of sequence) {
    const g = geometry[gIdx];
    if (!g) continue;
    const pts = entityToPoints(g);
    if (pts.length === 0) continue;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (path.length === 0) {
        path.push({ x: p.x, y: p.y, dist: 0, rapid: false, entityIdx: gIdx });
      } else {
        const prev = path[path.length - 1];
        const d = dist(prev, p);
        if (d < 1e-6) continue;

        const isRapid = (i === 0 && d > GAP_THRESHOLD);
        path.push({ x: p.x, y: p.y, dist: prev.dist + d, rapid: isRapid, entityIdx: gIdx });
      }
    }
  }

  return path;
}

/**
 * Given the simulation path and current distance, return the set of entity
 * indices that have been fully cut through (all their points are behind `distance`).
 */
export function getCompletedEntityIndices(simPath, distance) {
  if (!simPath || simPath.length === 0) return new Set();

  // Find the max dist for each entity, and the min dist for each entity
  const entityMax = new Map(); // entityIdx -> max dist in path
  const entityMin = new Map();
  for (const pt of simPath) {
    if (pt.rapid) continue; // rapid segments don't belong to entity cutting
    const idx = pt.entityIdx;
    if (!entityMax.has(idx) || pt.dist > entityMax.get(idx)) entityMax.set(idx, pt.dist);
    if (!entityMin.has(idx) || pt.dist < entityMin.get(idx)) entityMin.set(idx, pt.dist);
  }

  const completed = new Set();
  for (const [idx, maxDist] of entityMax) {
    if (maxDist <= distance) completed.add(idx);
  }
  return completed;
}

function entityToPoints(g) {
  switch (g.type) {
    case 'line':
    case 'spline':
      return g.points;
    case 'polyline': {
      const out = [];
      for (let i = 0; i < g.points.length; i++) {
        if (i === 0) { out.push({ x: g.points[0].x, y: g.points[0].y }); continue; }
        const prev = g.points[i - 1], cur = g.points[i];
        if (prev.bulge && prev.bulge !== 0) {
          const arc = bulgeToArc(prev, cur, prev.bulge);
          if (arc) {
            const arcPts = tessArc(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle, arc.ccw);
            for (let j = 1; j < arcPts.length; j++) out.push(arcPts[j]);
          } else {
            out.push({ x: cur.x, y: cur.y });
          }
        } else {
          out.push({ x: cur.x, y: cur.y });
        }
      }
      return out;
    }
    case 'circle': {
      const pts = [];
      const S = 64;
      for (let i = 0; i <= S; i++) {
        const a = (2 * Math.PI * i) / S;
        pts.push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
      }
      return pts;
    }
    case 'arc':
      return tessArc(g.cx, g.cy, g.r, g.startAngle, g.endAngle, true);
    default:
      return [];
  }
}

function tessArc(cx, cy, r, sa, ea, ccw) {
  let sweep = ea - sa;
  if (ccw) { if (sweep < 0) sweep += 2 * Math.PI; }
  else { if (sweep > 0) sweep -= 2 * Math.PI; }
  const S = Math.max(16, Math.round(Math.abs(sweep) / (Math.PI / 32)));
  const pts = [];
  for (let i = 0; i <= S; i++) {
    const a = sa + sweep * (i / S);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Interpolate position along simulation path at a given cumulative distance */
export function interpolatePathAt(simPath, distance) {
  if (!simPath || simPath.length === 0) return null;
  if (distance <= 0) return { x: simPath[0].x, y: simPath[0].y };
  const last = simPath[simPath.length - 1];
  if (distance >= last.dist) return { x: last.x, y: last.y };

  let lo = 0, hi = simPath.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (simPath[mid].dist <= distance) lo = mid; else hi = mid;
  }
  const a = simPath[lo], b = simPath[hi];
  const segLen = b.dist - a.dist;
  if (segLen < 1e-10) return { x: a.x, y: a.y };
  const t = (distance - a.dist) / segLen;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Get segments from 0..distance, split into cut segments and rapid segments.
 * Returns { cuts: [ [{x,y},...], ... ], rapids: [ [{x,y},...], ... ] }
 *   cuts   = array of polylines (torch on)
 *   rapids = array of polylines (torch off / lift moves)
 */
export function getSubPath(simPath, distance) {
  if (!simPath || simPath.length === 0) return { cuts: [], rapids: [] };

  const cuts = [];
  const rapids = [];
  let currentCut = [{ x: simPath[0].x, y: simPath[0].y }];
  let currentRapid = null;

  for (let i = 1; i < simPath.length; i++) {
    const pt = simPath[i];
    const inRange = pt.dist <= distance;

    if (inRange) {
      if (pt.rapid) {
        // Finish current cut segment
        if (currentCut && currentCut.length >= 2) cuts.push(currentCut);
        // Start a rapid segment from previous point to this point
        const prev = simPath[i - 1];
        rapids.push([{ x: prev.x, y: prev.y }, { x: pt.x, y: pt.y }]);
        // Start new cut segment from this point
        currentCut = [{ x: pt.x, y: pt.y }];
      } else {
        currentCut.push({ x: pt.x, y: pt.y });
      }
    } else {
      // Interpolate the fractional last point
      const a = simPath[i - 1], b = pt;
      const segLen = b.dist - a.dist;
      if (segLen > 1e-10) {
        const t = (distance - a.dist) / segLen;
        const interp = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (b.rapid) {
          // Partially through a rapid move
          if (currentCut && currentCut.length >= 2) cuts.push(currentCut);
          rapids.push([{ x: a.x, y: a.y }, interp]);
          currentCut = null;
        } else {
          currentCut.push(interp);
        }
      }
      break;
    }
  }

  if (currentCut && currentCut.length >= 2) cuts.push(currentCut);
  return { cuts, rapids };
}

/**
 * Determine if the head is currently in a rapid move at the given distance.
 */
export function isRapidAt(simPath, distance) {
  if (!simPath || simPath.length < 2) return false;
  for (let i = 1; i < simPath.length; i++) {
    if (simPath[i].dist >= distance) {
      return simPath[i].rapid;
    }
  }
  return false;
}

// ─── Bulge helpers ──────────────────────────────────────────────────────────────

function bulgeToArc(p1, p2, bulge) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord < 1e-10) return null;
  const sagitta = Math.abs(bulge) * chord / 2;
  const r = (chord * chord / 4 + sagitta * sagitta) / (2 * sagitta);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const ux = dx / chord, uy = dy / chord;
  const d = r - sagitta;
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx - sign * d * uy;
  const cy = my + sign * d * ux;
  return { cx, cy, r, startAngle: Math.atan2(p1.y - cy, p1.x - cx), endAngle: Math.atan2(p2.y - cy, p2.x - cx), ccw: bulge > 0 };
}

function bulgeArcLength(p1, p2, bulge) {
  const theta = 4 * Math.atan(Math.abs(bulge));
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord < 1e-10) return 0;
  return (chord / (2 * Math.sin(theta / 2))) * theta;
}

function bulgeArcBounds(p1, p2, bulge) {
  const arc = bulgeToArc(p1, p2, bulge);
  if (!arc) return { minX: Math.min(p1.x, p2.x), minY: Math.min(p1.y, p2.y), maxX: Math.max(p1.x, p2.x), maxY: Math.max(p1.y, p2.y) };
  return { minX: arc.cx - arc.r, minY: arc.cy - arc.r, maxX: arc.cx + arc.r, maxY: arc.cy + arc.r };
}

export { bulgeToArc };

function dist(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}
