/**
 * canvasRenderer.js — Renders DXF geometry + simulation overlay onto an HTML Canvas.
 *
 * Transform pipeline (world → screen):
 *   screenX = (worldX + panX) * zoom
 *   screenY = (-worldY + panY) * zoom    ← Y negated to flip CAD Y-up → canvas Y-down
 */

import { bulgeToArc } from './dxfHelpers.js';

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

/**
 * Render the full scene.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width  - canvas CSS width
 * @param {number} height - canvas CSS height
 * @param {Array}  geometry
 * @param {Object} transform - { panX, panY, zoom }
 * @param {Object} options - { showNodes, showStartPoint, startPoint, nodes, simState }
 *   simState: { active, cutPath, headPos } — if active, render cut overlay
 */
export function renderScene(ctx, width, height, geometry, transform, options = {}) {
  const { panX, panY, zoom } = transform;
  const dpr = window.devicePixelRatio || 1;

  // Clear to dark table surface
  ctx.fillStyle = '#0d0d18';
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, transform);

  // ── Draw sheet metal plate ──────────────────────────────────────────────────
  const isRaisePhase = options.simState?.raiseProgress > 0;
  const sheetFade = options.simState?.fadeProgress || 0;
  const sheetAlpha = 1 - sheetFade;

  // If raising, draw the drop shadow UNDER the sheet metal (on the table)
  if (isRaisePhase && sheetAlpha > 0) {
    const rp = options.simState.raiseProgress;
    const lift = options.simState.liftAmount * easeOutCubic(rp);
    ctx.save();
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX * zoom, dpr * panY * zoom);
    ctx.translate(lift * 0.15, lift * 0.1);
    ctx.globalAlpha = 0.35 * Math.min(1, rp * 2) * sheetAlpha;
    drawFilledGeometry(ctx, geometry, options.bbox, '#000000');
    ctx.restore();
  }

  if (sheetAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = sheetAlpha;
    drawSheetMetal(ctx, width, height, transform, options.bbox, isRaisePhase ? geometry : null, options.kerf || 2);
    ctx.restore();
  }

  ctx.save();
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX * zoom, dpr * panY * zoom);

  const kerf = options.kerf || 2;
  const lw = Math.max(1.5, kerf) / zoom;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── Raise phase: parts lifting after cut ──────────────────────────────────

  if (options.simState?.raiseProgress > 0) {
    const rp = options.simState.raiseProgress;
    const lift = options.simState.liftAmount * easeOutCubic(rp);
    const bb = options.bbox;

    // Raised solid metal piece
    ctx.save();
    ctx.translate(0, -lift);
    drawFilledGeometry(ctx, geometry, bb, '#484858');

    // Cut edge highlight
    ctx.strokeStyle = '#6a6a78';
    ctx.lineWidth = (kerf * 0.5) / zoom;
    for (const g of geometry) drawEntity(ctx, g);

    // Hot edge glow fading with progress
    const edgeGlow = Math.max(0, 1 - rp * 0.7);
    if (edgeGlow > 0) {
      ctx.strokeStyle = `rgba(255, 140, 0, ${edgeGlow * 0.5})`;
      ctx.lineWidth = (kerf + 1) / zoom;
      ctx.shadowColor = `rgba(255, 100, 0, ${edgeGlow * 0.3})`;
      ctx.shadowBlur = 6 / zoom;
      for (const g of geometry) drawEntity(ctx, g);
      ctx.shadowBlur = 0;
    }
    ctx.restore();

  // ── Simulation overlay (cutting phase) ────────────────────────────────────

  } else if (options.simState?.active) {
    // Uncut geometry on sheet — faint etch/scribe marks
    ctx.strokeStyle = '#555565';
    ctx.lineWidth = kerf / zoom;
    for (const g of geometry) drawEntity(ctx, g);

    const { cuts, rapids, headPos, headIsRapid } = options.simState;

    // Completed cut segments — bright orange with glow
    if (cuts) {
      ctx.strokeStyle = '#ff8c00';
      ctx.lineWidth = kerf / zoom;
      ctx.shadowColor = '#ff8c00';
      ctx.shadowBlur = 6 / zoom;
      for (const seg of cuts) {
        if (seg.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(seg[0].x, -seg[0].y);
        for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, -seg[i].y);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Rapid/lift moves — dashed green
    if (rapids) {
      ctx.strokeStyle = 'rgba(0, 200, 100, 0.5)';
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([8 / zoom, 6 / zoom]);
      for (const seg of rapids) {
        if (seg.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(seg[0].x, -seg[0].y);
        for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, -seg[i].y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Plasma head
    if (headPos) {
      const hr = 6 / zoom;
      if (headIsRapid) {
        ctx.fillStyle = 'rgba(0, 200, 100, 0.2)';
        ctx.beginPath();
        ctx.arc(headPos.x, -headPos.y, hr * 2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#44ddaa';
        ctx.beginPath();
        ctx.arc(headPos.x, -headPos.y, hr * 0.6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = 'rgba(0, 200, 100, 0.7)';
        ctx.font = `${10 / zoom}px monospace`;
        ctx.fillText('RAPID', headPos.x + 10 / zoom, -headPos.y - 10 / zoom);
      } else {
        ctx.fillStyle = 'rgba(255, 140, 0, 0.3)';
        ctx.beginPath();
        ctx.arc(headPos.x, -headPos.y, hr * 3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 200, 50, 0.6)';
        ctx.beginPath();
        ctx.arc(headPos.x, -headPos.y, hr * 1.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(headPos.x, -headPos.y, hr * 0.7, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 220, 100, 0.7)';
        const seed = (headPos.x * 1000 + headPos.y * 7777) | 0;
        for (let i = 0; i < 6; i++) {
          const angle = ((seed + i * 987) % 360) * Math.PI / 180;
          const sparkDist = (hr * 2) + ((seed + i * 123) % 100) / 100 * hr * 2;
          const sx = headPos.x + Math.cos(angle) * sparkDist;
          const sy = -headPos.y + Math.sin(angle) * sparkDist;
          ctx.beginPath();
          ctx.arc(sx, sy, 1.5 / zoom, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }

  // ── Normal display (no simulation) ────────────────────────────────────────

  } else {
    // Scribe marks on sheet metal
    ctx.strokeStyle = '#8ecae6';
    ctx.lineWidth = lw;
    for (const g of geometry) drawEntity(ctx, g);
  }

  // ── Show nodes ────────────────────────────────────────────────────────────

  if (options.showNodes && options.nodes) {
    const dotR = 3 / zoom;
    ctx.fillStyle = '#ff6b6b';
    for (const n of options.nodes) {
      ctx.beginPath();
      ctx.arc(n.x, -n.y, dotR, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // ── Show start point ──────────────────────────────────────────────────────

  if (options.showStartPoint && options.startPoint) {
    const dotR = 5 / zoom;
    const sp = options.startPoint;
    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.arc(sp.x, -sp.y, dotR, 0, 2 * Math.PI);
    ctx.fill();
    ctx.font = `${12 / zoom}px monospace`;
    ctx.fillText('START', sp.x + 8 / zoom, -sp.y - 8 / zoom);
  }

  ctx.restore();

  // ── Simulation HUD (screen-space) ─────────────────────────────────────────

  if (options.simState?.active && options.simState.progress != null) {
    const pct = Math.round(options.simState.progress * 100);
    let label, hudColor;
    if (options.simState.raiseProgress >= 1) {
      const issueCount = options.issues?.length || 0;
      if (issueCount === 0) {
        label = '✓ Success';
        hudColor = '#00ff88';
      } else {
        label = `⚠ ${issueCount} Issue${issueCount > 1 ? 's' : ''} Found`;
        hudColor = '#ffcc00';
      }
    } else if (options.simState.raiseProgress > 0) {
      label = 'Lifting...';
      hudColor = '#ff8c00';
    } else {
      label = `Cutting: ${pct}%`;
      hudColor = '#ff8c00';
    }
    const boxW = Math.max(170, ctx.measureText(label).width + 30);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(width - boxW - 10, 10, boxW, 36);
    ctx.fillStyle = hudColor;
    ctx.font = '14px monospace';
    ctx.fillText(label, width - boxW, 33);
    // Progress bar
    ctx.fillStyle = '#333';
    ctx.fillRect(width - boxW, 38, boxW - 20, 4);
    ctx.fillStyle = hudColor;
    ctx.fillRect(width - boxW, 38, (boxW - 20) * options.simState.progress, 4);
  }
}

// ─── Draw direction arrow ───────────────────────────────────────────────────────

function drawArrow(ctx, p1, p2, headLen, color) {
  const dx = p2.x - p1.x, dy = -p2.y - (-p1.y);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return;
  const angle = Math.atan2(dy, dx);
  const mx = (p1.x + p2.x) / 2, my = (-p1.y + -p2.y) / 2;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(mx + headLen * Math.cos(angle), my + headLen * Math.sin(angle));
  ctx.lineTo(mx - headLen * Math.cos(angle - Math.PI / 5), my - headLen * Math.sin(angle - Math.PI / 5));
  ctx.lineTo(mx - headLen * Math.cos(angle + Math.PI / 5), my - headLen * Math.sin(angle + Math.PI / 5));
  ctx.closePath();
  ctx.fill();
}

// ─── Draw a single geometry entity ──────────────────────────────────────────────

function drawEntity(ctx, g) {
  ctx.beginPath();
  traceEntity(ctx, g);
  ctx.stroke();
}

/** Add entity path to context without beginning/stroking — for composing clips/fills */
function traceEntity(ctx, g) {
  switch (g.type) {
    case 'line':
      ctx.moveTo(g.points[0].x, -g.points[0].y);
      ctx.lineTo(g.points[1].x, -g.points[1].y);
      break;

    case 'polyline':
      for (let i = 0; i < g.points.length; i++) {
        const p = g.points[i];
        if (i === 0) {
          ctx.moveTo(p.x, -p.y);
        } else {
          const prev = g.points[i - 1];
          if (prev.bulge && prev.bulge !== 0) {
            const arc = bulgeToArc(prev, p, prev.bulge);
            if (arc) {
              ctx.arc(arc.cx, -arc.cy, arc.r, -arc.startAngle, -arc.endAngle, arc.ccw);
            } else {
              ctx.lineTo(p.x, -p.y);
            }
          } else {
            ctx.lineTo(p.x, -p.y);
          }
        }
      }
      break;

    case 'spline':
      if (g.points.length > 0) {
        ctx.moveTo(g.points[0].x, -g.points[0].y);
        for (let i = 1; i < g.points.length; i++) {
          ctx.lineTo(g.points[i].x, -g.points[i].y);
        }
      }
      break;

    case 'circle':
      ctx.arc(g.cx, -g.cy, g.r, 0, 2 * Math.PI);
      break;

    case 'arc':
      ctx.arc(g.cx, -g.cy, g.r, -g.startAngle, -g.endAngle, true);
      break;
  }
}

// ─── Chained geometry helpers ────────────────────────────────────────────────────

/** Convert any entity to an array of screen-space points (Y negated), tessellating arcs/bulges. */
function entityToScreenPoints(g) {
  const pts = [];
  switch (g.type) {
    case 'line':
      pts.push({ x: g.points[0].x, y: -g.points[0].y });
      pts.push({ x: g.points[1].x, y: -g.points[1].y });
      break;

    case 'polyline':
      for (let i = 0; i < g.points.length; i++) {
        const p = g.points[i];
        if (i === 0) { pts.push({ x: p.x, y: -p.y }); continue; }
        const prev = g.points[i - 1];
        if (prev.bulge && prev.bulge !== 0) {
          const arc = bulgeToArc(prev, p, prev.bulge);
          if (arc) {
            let a1 = arc.startAngle, a2 = arc.endAngle;
            if (arc.ccw) { if (a2 > a1) a2 -= 2 * Math.PI; }
            else { if (a2 < a1) a2 += 2 * Math.PI; }
            const steps = Math.max(8, Math.ceil(Math.abs(a2 - a1) / (Math.PI / 16)));
            for (let s = 1; s <= steps; s++) {
              const a = a1 + (a2 - a1) * (s / steps);
              pts.push({ x: arc.cx + arc.r * Math.cos(a), y: -(arc.cy + arc.r * Math.sin(a)) });
            }
          } else {
            pts.push({ x: p.x, y: -p.y });
          }
        } else {
          pts.push({ x: p.x, y: -p.y });
        }
      }
      break;

    case 'spline':
      for (const p of g.points) pts.push({ x: p.x, y: -p.y });
      break;

    case 'circle': {
      const steps = 64;
      for (let i = 0; i <= steps; i++) {
        const a = (2 * Math.PI * i) / steps;
        pts.push({ x: g.cx + g.r * Math.cos(a), y: -(g.cy + g.r * Math.sin(a)) });
      }
      break;
    }

    case 'arc': {
      let a1 = g.startAngle, a2 = g.endAngle;
      if (a2 < a1) a2 += 2 * Math.PI;
      const steps = Math.max(12, Math.ceil(Math.abs(a2 - a1) / (Math.PI / 16)));
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (a2 - a1) * (s / steps);
        pts.push({ x: g.cx + g.r * Math.cos(a), y: -(g.cy + g.r * Math.sin(a)) });
      }
      break;
    }
  }
  return pts;
}

function ptDist2d(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }

/**
 * Trace all geometry as chained continuous paths.
 * Entities sharing endpoints are connected into single sub-paths.
 * Each chain is closed with closePath() for proper even-odd filling.
 */
function traceChainedGeometry(ctx, geometry) {
  const SNAP = 0.5;
  const allPts = geometry.map(g => entityToScreenPoints(g));
  const used = new Array(geometry.length).fill(false);

  // Handle self-closed entities (circles, closed polylines) first
  for (let i = 0; i < geometry.length; i++) {
    const pts = allPts[i];
    if (pts.length < 2) continue;
    const selfClosed = geometry[i].type === 'circle' || ptDist2d(pts[0], pts[pts.length - 1]) < SNAP;
    if (selfClosed) {
      used[i] = true;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.closePath();
    }
  }

  // Chain remaining entities by endpoint proximity
  while (true) {
    let startIdx = -1;
    for (let i = 0; i < geometry.length; i++) { if (!used[i]) { startIdx = i; break; } }
    if (startIdx === -1) break;

    // Build chain: array of { pts, reversed }
    const chain = [{ pts: allPts[startIdx], reversed: false }];
    used[startIdx] = true;
    let chainStart = allPts[startIdx][0];
    let chainEnd = allPts[startIdx][allPts[startIdx].length - 1];

    let found = true;
    while (found) {
      found = false;
      for (let i = 0; i < geometry.length; i++) {
        if (used[i]) continue;
        const pts = allPts[i];
        if (pts.length < 2) { used[i] = true; continue; }
        const s = pts[0], e = pts[pts.length - 1];

        if (ptDist2d(s, chainEnd) < SNAP) {
          chain.push({ pts, reversed: false }); used[i] = true; chainEnd = e; found = true; break;
        }
        if (ptDist2d(e, chainEnd) < SNAP) {
          chain.push({ pts, reversed: true }); used[i] = true; chainEnd = s; found = true; break;
        }
        if (ptDist2d(e, chainStart) < SNAP) {
          chain.unshift({ pts, reversed: false }); used[i] = true; chainStart = s; found = true; break;
        }
        if (ptDist2d(s, chainStart) < SNAP) {
          chain.unshift({ pts, reversed: true }); used[i] = true; chainStart = e; found = true; break;
        }
      }
    }

    // Draw the chain as a single continuous sub-path
    for (let c = 0; c < chain.length; c++) {
      const { pts, reversed } = chain[c];
      if (reversed) {
        if (c === 0) ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        for (let j = pts.length - 2; j >= 0; j--) ctx.lineTo(pts[j].x, pts[j].y);
      } else {
        if (c === 0) ctx.moveTo(pts[0].x, pts[0].y);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      }
    }
    ctx.closePath();
  }
}

/** Draw geometry as a solid filled shape using even-odd fill to handle holes */
function drawFilledGeometry(ctx, geometry, bbox, fillStyle) {
  if (!bbox) return;
  ctx.save();
  ctx.beginPath();
  traceChainedGeometry(ctx, geometry);
  ctx.fillStyle = fillStyle;
  ctx.fill('evenodd');
  ctx.restore();
}

// ─── Sheet metal plate ──────────────────────────────────────────────────────────

function drawSheetMetal(ctx, width, height, transform, bbox, cutGeometry, kerf) {
  if (!bbox) return;
  const { panX, panY, zoom } = transform;
  const pad = Math.max(bbox.width, bbox.height) * 0.25;

  const sx1 = bbox.minX - pad;
  const sy1 = -(bbox.maxY + pad);
  const sx2 = bbox.maxX + pad;
  const sy2 = -(bbox.minY - pad);

  const left = (sx1 + panX) * zoom;
  const top = (sy1 + panY) * zoom;
  const right = (sx2 + panX) * zoom;
  const bottom = (sy2 + panY) * zoom;
  const w = right - left;
  const h = bottom - top;

  // Drop shadow under the plate
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#2a2a35';
  ctx.fillRect(left, top, w, h);
  ctx.restore();

  // Draw sheet to offscreen canvas so destination-out only affects the sheet
  const dpr = window.devicePixelRatio || 1;
  const offCanvas = document.createElement('canvas');
  offCanvas.width = width * dpr;
  offCanvas.height = height * dpr;
  const off = offCanvas.getContext('2d');
  off.scale(dpr, dpr);

  // Metal gradient
  const metalGrad = off.createLinearGradient(left, top, left, bottom);
  metalGrad.addColorStop(0, '#4a4a55');
  metalGrad.addColorStop(0.15, '#3d3d48');
  metalGrad.addColorStop(0.4, '#434350');
  metalGrad.addColorStop(0.6, '#3a3a45');
  metalGrad.addColorStop(0.85, '#404050');
  metalGrad.addColorStop(1, '#353540');
  off.fillStyle = metalGrad;
  off.fillRect(left, top, w, h);

  // Brushed texture
  off.globalAlpha = 0.06;
  off.strokeStyle = '#ffffff';
  off.lineWidth = 1;
  off.beginPath();
  for (let y = top; y < bottom; y += 2) {
    off.moveTo(left, y); off.lineTo(right, y);
  }
  off.stroke();
  off.globalAlpha = 1;

  // Punch hole if cut geometry provided
  if (cutGeometry) {
    off.globalCompositeOperation = 'destination-out';
    off.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX * zoom, dpr * panY * zoom);

    // Fill the cut shape area
    off.beginPath();
    traceChainedGeometry(off, cutGeometry);
    off.fillStyle = 'rgba(0,0,0,1)';
    off.fill('evenodd');

    // Erase kerf edges
    off.lineWidth = (kerf + 2) / zoom;
    off.lineCap = 'round';
    off.lineJoin = 'round';
    off.strokeStyle = 'rgba(0,0,0,1)';
    off.beginPath();
    traceChainedGeometry(off, cutGeometry);
    off.stroke();

    off.globalCompositeOperation = 'source-over';
    off.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Scorch marks on remaining sheet
    off.save();
    off.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX * zoom, dpr * panY * zoom);
    off.strokeStyle = 'rgba(80, 50, 20, 0.25)';
    off.lineWidth = (kerf + 8) / zoom;
    off.lineCap = 'round';
    off.lineJoin = 'round';
    for (const g of cutGeometry) drawEntity(off, g);
    off.restore();
  }

  // Beveled edges
  const bevel = Math.min(3, w * 0.01);
  off.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  off.lineWidth = bevel;
  off.beginPath();
  off.moveTo(left, bottom); off.lineTo(left, top); off.lineTo(right, top);
  off.stroke();
  off.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  off.beginPath();
  off.moveTo(right, top); off.lineTo(right, bottom); off.lineTo(left, bottom);
  off.stroke();

  // Paste offscreen sheet onto main canvas
  ctx.drawImage(offCanvas, 0, 0, offCanvas.width, offCanvas.height, 0, 0, width, height);
}

// ─── Grid ───────────────────────────────────────────────────────────────────────

function drawGrid(ctx, width, height, { panX, panY, zoom }) {
  const worldSpacing = 80 / zoom;
  const mag = Math.pow(10, Math.floor(Math.log10(worldSpacing)));
  let spacing;
  if (worldSpacing / mag < 2) spacing = mag;
  else if (worldSpacing / mag < 5) spacing = 2 * mag;
  else spacing = 5 * mag;

  const worldLeft = -panX;
  const worldTop = -panY;
  const worldRight = worldLeft + width / zoom;
  const worldBottom = worldTop + height / zoom;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;

  const startX = Math.floor(worldLeft / spacing) * spacing;
  const startY = Math.floor(worldTop / spacing) * spacing;

  ctx.beginPath();
  for (let wx = startX; wx <= worldRight; wx += spacing) {
    const sx = (wx + panX) * zoom;
    ctx.moveTo(sx, 0); ctx.lineTo(sx, height);
  }
  for (let wy = startY; wy <= worldBottom; wy += spacing) {
    const sy = (wy + panY) * zoom;
    ctx.moveTo(0, sy); ctx.lineTo(width, sy);
  }
  ctx.stroke();
}

// ─── Fit to screen ──────────────────────────────────────────────────────────────

/**
 * Returns { panX, panY, zoom } centering bbox in canvas.
 * zoom = min(canvasW/bboxW, canvasH/bboxH) * 0.85
 * panX = canvasW/(2*zoom) - centerX
 * panY = canvasH/(2*zoom) - (-centerY)   (Y flipped)
 */
export function fitToScreen(bbox, canvasWidth, canvasHeight) {
  const bboxW = bbox.width || 1;
  const bboxH = bbox.height || 1;
  const zoom = Math.min(canvasWidth / bboxW, canvasHeight / bboxH) * 0.40;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = -(bbox.minY + bbox.maxY) / 2;
  return { panX: canvasWidth / (2 * zoom) - cx, panY: canvasHeight / (2 * zoom) - cy, zoom };
}
