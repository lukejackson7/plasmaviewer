/**
 * dxfExporter.js — Export cleaned DXF geometry as an R12-compatible DXF string.
 *
 * Cleaning:
 *   - Removes duplicate entities (keeps first of each duplicate pair)
 *   - Snaps tiny gaps to midpoint
 */

export function exportCleanedDxf(geometry, issues) {
  // Collect duplicate entity indices to remove (keep first, remove second)
  const dupIndices = new Set();
  for (const issue of issues) {
    if (issue.type === 'duplicate') dupIndices.add(issue.entityIndices[1]);
  }

  // Deep-clone geometry for gap snapping
  const geo = geometry.map(g => JSON.parse(JSON.stringify(g)));

  // Snap tiny gaps
  for (const issue of issues) {
    if (issue.type !== 'tiny-gap' || issue.points.length < 2) continue;
    const mid = {
      x: (issue.points[0].x + issue.points[1].x) / 2,
      y: (issue.points[0].y + issue.points[1].y) / 2,
    };
    for (const idx of issue.entityIndices) {
      snapNearestEndpoint(geo[idx], issue.points, mid);
    }
  }

  const clean = geo.filter((_, i) => !dupIndices.has(i));
  return buildDxfString(clean);
}

function snapNearestEndpoint(g, targets, snapTo) {
  if (!g) return;
  switch (g.type) {
    case 'line':
    case 'spline':
      for (const t of targets) {
        if (near(g.points[0], t)) { g.points[0] = { ...g.points[0], ...snapTo }; return; }
        const last = g.points.length - 1;
        if (near(g.points[last], t)) { g.points[last] = { ...g.points[last], ...snapTo }; return; }
      }
      break;
    case 'polyline':
      for (const t of targets) {
        if (near(g.points[0], t)) { g.points[0].x = snapTo.x; g.points[0].y = snapTo.y; return; }
        const last = g.points.length - 1;
        if (near(g.points[last], t)) { g.points[last].x = snapTo.x; g.points[last].y = snapTo.y; return; }
      }
      break;
    default:
      break;
  }
}

function near(a, b) { return Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2; }

// ─── Scaling ─────────────────────────────────────────────────────────────────

/** Uniformly scale all geometry coordinates (and radii) by `factor`. Bulge values
 *  are dimensionless (ratio-based) so they're left untouched. */
export function scaleGeometry(geometry, factor) {
  if (!factor || factor === 1) return geometry;
  return geometry.map(g => scaleEntity(g, factor));
}

function scaleEntity(g, f) {
  switch (g.type) {
    case 'line':
    case 'spline':
      return { ...g, points: g.points.map(p => ({ ...p, x: p.x * f, y: p.y * f })) };
    case 'polyline':
      return { ...g, points: g.points.map(p => ({ ...p, x: p.x * f, y: p.y * f })) };
    case 'circle':
      return { ...g, cx: g.cx * f, cy: g.cy * f, r: g.r * f };
    case 'arc':
      return { ...g, cx: g.cx * f, cy: g.cy * f, r: g.r * f };
    default:
      return g;
  }
}

/** Export geometry as-is (no cleaning/scaling) to a DXF string. */
export function exportDxf(geometry) {
  return buildDxfString(geometry);
}

/** Scale geometry by `factor` and export the result as a DXF string. */
export function exportScaledDxf(geometry, factor) {
  return buildDxfString(scaleGeometry(geometry, factor));
}

// ─── DXF R12 writer ─────────────────────────────────────────────────────────────

function buildDxfString(geometry) {
  let dxf = '';

  // Header
  dxf += '0\nSECTION\n2\nHEADER\n';
  dxf += '9\n$ACADVER\n1\nAC1009\n';
  dxf += '0\nENDSEC\n';

  // Minimal tables
  dxf += '0\nSECTION\n2\nTABLES\n';
  dxf += '0\nTABLE\n2\nLAYER\n70\n1\n';
  dxf += '0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n';
  dxf += '0\nENDTAB\n';
  dxf += '0\nENDSEC\n';

  // Entities
  dxf += '0\nSECTION\n2\nENTITIES\n';

  for (const g of geometry) {
    switch (g.type) {
      case 'line':
        dxf += '0\nLINE\n8\n0\n';
        dxf += `10\n${g.points[0].x}\n20\n${g.points[0].y}\n30\n0\n`;
        dxf += `11\n${g.points[1].x}\n21\n${g.points[1].y}\n31\n0\n`;
        break;

      case 'circle':
        dxf += '0\nCIRCLE\n8\n0\n';
        dxf += `10\n${g.cx}\n20\n${g.cy}\n30\n0\n40\n${g.r}\n`;
        break;

      case 'arc':
        dxf += '0\nARC\n8\n0\n';
        dxf += `10\n${g.cx}\n20\n${g.cy}\n30\n0\n40\n${g.r}\n`;
        dxf += `50\n${(g.startAngle * 180) / Math.PI}\n51\n${(g.endAngle * 180) / Math.PI}\n`;
        break;

      case 'polyline': {
        const pts = g.points;
        const closed =
          pts.length > 2 &&
          Math.abs(pts[0].x - pts[pts.length - 1].x) < 0.001 &&
          Math.abs(pts[0].y - pts[pts.length - 1].y) < 0.001;
        const count = closed ? pts.length - 1 : pts.length;
        dxf += `0\nLWPOLYLINE\n8\n0\n70\n${closed ? 1 : 0}\n90\n${count}\n`;
        for (let i = 0; i < count; i++) {
          dxf += `10\n${pts[i].x}\n20\n${pts[i].y}\n`;
          if (pts[i].bulge) dxf += `42\n${pts[i].bulge}\n`;
        }
        break;
      }

      case 'spline':
        // Export tessellated spline as LWPOLYLINE
        dxf += `0\nLWPOLYLINE\n8\n0\n70\n0\n90\n${g.points.length}\n`;
        for (const p of g.points) dxf += `10\n${p.x}\n20\n${p.y}\n`;
        break;
    }
  }

  dxf += '0\nENDSEC\n0\nEOF\n';
  return dxf;
}
