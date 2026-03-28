import { useState, useRef, useEffect, useCallback } from 'react';
import {
  parseDxfText,
  extractGeometry,
  computeBoundingBox,
  computeCutLength,
  collectNodes,
  getStartPoint,
  buildSimulationPath,
  interpolatePathAt,
  getSubPath,
  isRapidAt,
} from './dxfHelpers.js';
import { renderScene, renderLiftedPiece, fitToScreen } from './canvasRenderer.js';
import { runPlasmaChecks } from './plasmaChecks.js';
import { exportCleanedDxf } from './dxfExporter.js';

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────

  const [fileName, setFileName] = useState(null);
  const [geometry, setGeometry] = useState([]);
  const [bbox, setBbox] = useState(null);
  const [cutLength, setCutLength] = useState(0);
  const [entityCount, setEntityCount] = useState(0);
  const [showNodes, setShowNodes] = useState(false);
  const [showStartPoint, setShowStartPoint] = useState(false);
  const [showIssues, setShowIssues] = useState(true);
  const [showLoops, setShowLoops] = useState(false);
  const [issues, setIssues] = useState([]);
  const [loops, setLoops] = useState([]);
  const [error, setError] = useState(null);
  const [transform, setTransform] = useState({ panX: 0, panY: 0, zoom: 1 });

  // Simulation state
  const [simActive, setSimActive] = useState(false);
  const [simSpeed, setSimSpeed] = useState(1); // 1x, 2x, 5x, 10x
  const [kerf, setKerf] = useState(2);
  const [simHud, setSimHud] = useState(null); // { label, color, progress }
  const [liftZ, setLiftZ] = useState(0); // CSS translateZ for lifted piece

  const canvasRef = useRef(null);
  const liftCanvasRef = useRef(null);
  const containerRef = useRef(null);
  const barRef = useRef(null);
  const nodesRef = useRef([]);
  const startPointRef = useRef(null);
  const geometryRef = useRef([]);
  const transformRef = useRef(transform);
  const rafRef = useRef(null);
  const isPanning = useRef(false);
  const isTilting = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const [tilt, setTilt] = useState({ rotX: 0, rotY: 0 });

  // Simulation refs
  const simPathRef = useRef(null);
  const simDistRef = useRef(0);          // current distance along path
  const simActiveRef = useRef(false);
  const simSpeedRef = useRef(1);
  const tiltRef = useRef({ rotX: 0, rotY: 0 });
  const lastFrameTimeRef = useRef(0);
  const raisePhaseRef = useRef(false);
  const raiseStartRef = useRef(0);
  const simDoneRef = useRef(false);
  const liftAmountRef = useRef(10);
  const kerfRef = useRef(2);

  // Keep refs in sync
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { geometryRef.current = geometry; }, [geometry]);
  useEffect(() => { simActiveRef.current = simActive; }, [simActive]);
  useEffect(() => { simSpeedRef.current = simSpeed; }, [simSpeed]);
  useEffect(() => { kerfRef.current = kerf; }, [kerf]);

  // ── Canvas resize ─────────────────────────────────────────────────────────

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }, []);

  useEffect(() => {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, [resizeCanvas]);

  // ── Structured data (JSON-LD) for SEO ─────────────────────────────────────
  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": "PlasmaViewer",
      "url": "https://plasmaviewer.com",
      "description": "Free online DXF file viewer and plasma cutting simulator with real-time cut animation, health checks, and DXF export.",
      "applicationCategory": "DesignApplication",
      "operatingSystem": "Any",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "featureList": [
        "DXF file viewing", "Plasma cut simulation", "Open contour detection",
        "Duplicate entity detection", "Cleaned DXF export", "Kerf width adjustment",
        "Pan and zoom navigation"
      ]
    });
    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  // ── Initialize AdSense ad units ───────────────────────────────────────────
  useEffect(() => {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
  }, []);

  // ── Render loop ───────────────────────────────────────────────────────────

  const renderLoop = useCallback((timestamp) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Advance simulation if active
    let simState = null;
    if (simActiveRef.current && simPathRef.current && simPathRef.current.length > 0) {
      const dt = lastFrameTimeRef.current ? (timestamp - lastFrameTimeRef.current) / 1000 : 0;
      lastFrameTimeRef.current = timestamp;

      const totalDist = simPathRef.current[simPathRef.current.length - 1].dist;

      if (raisePhaseRef.current) {
        // Raise phase — parts lifting after cutting completes
        const elapsed = timestamp - raiseStartRef.current;
        const raiseProgress = Math.min(1, elapsed / 1500);
        // After lift completes, fade the background sheet over 1000ms
        const fadeProgress = raiseProgress >= 1 ? Math.min(1, (elapsed - 1500) / 1000) : 0;
        simState = {
          active: true,
          headPos: null,
          cuts: null,
          rapids: null,
          headIsRapid: false,
          progress: 1,
          raiseProgress,
          fadeProgress,
          liftAmount: liftAmountRef.current,
        };
      } else {
        // Cutting phase
        const baseSpeed = totalDist / 8;
        simDistRef.current += baseSpeed * simSpeedRef.current * dt;

        if (simDistRef.current >= totalDist) {
          simDistRef.current = totalDist;
          raisePhaseRef.current = true;
          raiseStartRef.current = timestamp;
        }

        const headPos = interpolatePathAt(simPathRef.current, simDistRef.current);
        const { cuts, rapids } = getSubPath(simPathRef.current, simDistRef.current);
        const headIsRapid = isRapidAt(simPathRef.current, simDistRef.current);
        simState = {
          active: true,
          headPos,
          cuts,
          rapids,
          headIsRapid,
          progress: totalDist > 0 ? simDistRef.current / totalDist : 0,
          raiseProgress: 0,
          liftAmount: liftAmountRef.current,
        };
      }
    }

    renderScene(ctx, w / dpr, h / dpr, geometryRef.current, transformRef.current, {
      showNodes,
      showStartPoint,
      nodes: nodesRef.current,
      startPoint: startPointRef.current,
      simState,
      kerf: kerfRef.current,
      showIssues,
      issues,
      showLoops,
      loops,
      bbox,
      tilt: tiltRef.current,
    });

    // Sync both canvas CSS transforms in the same frame to prevent jitter
    const t = tiltRef.current;
    const baseTransform = `rotateX(${t.rotX}deg) rotateY(${t.rotY}deg)`;
    canvas.style.transform = baseTransform;

    // Render lifted piece on overlay canvas with real CSS 3D
    const liftCanvas = liftCanvasRef.current;
    if (liftCanvas) {
      // Keep lift canvas sized to match main canvas
      if (liftCanvas.width !== w || liftCanvas.height !== h) {
        liftCanvas.width = w;
        liftCanvas.height = h;
      }
      const liftCtx = liftCanvas.getContext('2d');
      if (simState?.raiseProgress > 0) {
        const rp = simState.raiseProgress;
        const maxZ = 120; // max CSS translateZ in px
        const newZ = easeOutCubic(rp) * maxZ;
        liftCanvas.style.transform = `${baseTransform} translateZ(${newZ}px)`;
        renderLiftedPiece(liftCtx, w / dpr, h / dpr, geometryRef.current, transformRef.current, {
          raiseProgress: rp,
          kerf: kerfRef.current,
          bbox,
        });
      } else {
        liftCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        liftCtx.clearRect(0, 0, w / dpr, h / dpr);
        liftCanvas.style.transform = `${baseTransform} translateZ(0px)`;
      }
    }

    // Update HUD overlay state
    if (simState?.active && simState.progress != null) {
      const pct = Math.round(simState.progress * 100);
      const issueCount = issues?.length || 0;
      let label, color;
      if (simState.raiseProgress >= 1) {
        label = issueCount === 0 ? '✓ Success' : `⚠ ${issueCount} Issue${issueCount > 1 ? 's' : ''} Found`;
        color = issueCount === 0 ? '#00ff88' : '#ffcc00';
      } else if (simState.raiseProgress > 0) {
        label = 'Lifting...'; color = '#ff8c00';
      } else {
        label = `Cutting: ${pct}%`; color = '#ff8c00';
      }
      setSimHud({ label, color, progress: simState.progress });
      // Directly update bar DOM to bypass React batching lag
      if (barRef.current) {
        barRef.current.style.width = `${simState.progress * 100}%`;
        barRef.current.style.backgroundColor = color;
      }
    } else {
      setSimHud(null);
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  }, [showNodes, showStartPoint, showIssues, issues, showLoops, loops]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(renderLoop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [renderLoop]);

  // ── File handler ──────────────────────────────────────────────────────────

  const handleFile = useCallback((file) => {
    if (!file) return;
    setError(null);
    setSimActive(false);
    simActiveRef.current = false;
    simDistRef.current = 0;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target.result;
        const { entities } = parseDxfText(text);
        const geo = extractGeometry(entities);
        if (geo.length === 0) {
          setError('No supported entities found in DXF file.');
          return;
        }

        const bb = computeBoundingBox(geo);
        const cl = computeCutLength(geo);
        const nodes = collectNodes(geo);
        const sp = getStartPoint(geo);
        const simPath = buildSimulationPath(geo);

        setFileName(file.name);
        setGeometry(geo);
        setBbox(bb);
        setCutLength(cl);
        setEntityCount(geo.length);
        nodesRef.current = nodes;
        startPointRef.current = sp;
        geometryRef.current = geo;
        simPathRef.current = simPath;
        liftAmountRef.current = Math.max(bb.height, bb.width) * 0.15;

        const checks = runPlasmaChecks(geo);
        setIssues(checks.issues);
        setLoops(checks.loops);

        const canvas = canvasRef.current;
        if (canvas) {
          const dpr = window.devicePixelRatio || 1;
          const t = fitToScreen(bb, canvas.width / dpr, canvas.height / dpr);
          setTransform(t);
          transformRef.current = t;
        }
      } catch (e) {
        setError('Failed to parse DXF: ' + e.message);
      }
    };
    reader.readAsText(file);
  }, []);

  // ── Simulation controls ───────────────────────────────────────────────────

  const handleSimulate = useCallback(() => {
    if (!simPathRef.current || simPathRef.current.length === 0) return;
    simDistRef.current = 0;
    lastFrameTimeRef.current = 0;
    raisePhaseRef.current = false;
    raiseStartRef.current = 0;
    simDoneRef.current = false;
    setSimActive(true);
    simActiveRef.current = true;
  }, []);

  const handleStopSim = useCallback(() => {
    setSimActive(false);
    simActiveRef.current = false;
    simDistRef.current = 0;
    lastFrameTimeRef.current = 0;
    raisePhaseRef.current = false;
    raiseStartRef.current = 0;
    simDoneRef.current = false;
  }, []);

  // ── Mouse handlers ────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e) => {
    if (e.button === 0) {
      isPanning.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    } else if (e.button === 1) {
      if (e.detail === 2) {
        tiltRef.current = { rotX: 0, rotY: 0 };
        if (canvasRef.current) canvasRef.current.style.transform = 'rotateX(0deg) rotateY(0deg)';
        if (liftCanvasRef.current) liftCanvasRef.current.style.transform = 'rotateX(0deg) rotateY(0deg) translateZ(0px)';
      } else {
        isTilting.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
      e.preventDefault();
    }
  }, []);

  const onMouseMove = useCallback((e) => {
    if (isTilting.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      const prev = tiltRef.current;
      const next = {
        rotX: Math.max(-60, Math.min(60, prev.rotX - dy * 0.3)),
        rotY: Math.max(-60, Math.min(60, prev.rotY + dx * 0.3)),
      };
      tiltRef.current = next;
      // Update canvases immediately — no React state involved
      const baseTransform = `rotateX(${next.rotX}deg) rotateY(${next.rotY}deg)`;
      if (canvasRef.current) canvasRef.current.style.transform = baseTransform;
      if (liftCanvasRef.current) {
        // Preserve existing translateZ
        const cur = liftCanvasRef.current.style.transform;
        const zMatch = cur.match(/translateZ\([^)]+\)/);
        const zPart = zMatch ? ` ${zMatch[0]}` : ' translateZ(0px)';
        liftCanvasRef.current.style.transform = baseTransform + zPart;
      }
      return;
    }
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setTransform((prev) => {
      const t = { ...prev, panX: prev.panX + dx / prev.zoom, panY: prev.panY + dy / prev.zoom };
      transformRef.current = t;
      return t;
    });
  }, []);

  const onMouseUp = useCallback(() => { isPanning.current = false; isTilting.current = false; }, []);

  // ── Touch handlers (trackpad/mobile) ──────────────────────────────────────

  const lastTouchRef = useRef(null);
  const lastPinchDistRef = useRef(null);

  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 1) {
      isPanning.current = true;
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      isPanning.current = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDistRef.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchRef.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    }
    e.preventDefault();
  }, []);

  const onTouchMove = useCallback((e) => {
    e.preventDefault();
    if (e.touches.length === 1 && isPanning.current && lastTouchRef.current) {
      const dx = e.touches[0].clientX - lastTouchRef.current.x;
      const dy = e.touches[0].clientY - lastTouchRef.current.y;
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setTransform((prev) => {
        const t = { ...prev, panX: prev.panX + dx / prev.zoom, panY: prev.panY + dy / prev.zoom };
        transformRef.current = t;
        return t;
      });
    } else if (e.touches.length === 2 && lastPinchDistRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const zoomFactor = dist / lastPinchDistRef.current;
      lastPinchDistRef.current = dist;
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const cx = mx - rect.left;
        const cy = my - rect.top;
        setTransform((prev) => {
          const newZoom = prev.zoom * zoomFactor;
          const t = {
            panX: prev.panX + cx / newZoom - cx / prev.zoom,
            panY: prev.panY + cy / newZoom - cy / prev.zoom,
            zoom: newZoom,
          };
          transformRef.current = t;
          return t;
        });
      }
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    isPanning.current = false;
    lastTouchRef.current = null;
    lastPinchDistRef.current = null;
  }, []);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;

    setTransform((prev) => {
      const newZoom = prev.zoom * zoomFactor;
      const t = {
        panX: prev.panX + mx / newZoom - mx / prev.zoom,
        panY: prev.panY + my / newZoom - my / prev.zoom,
        zoom: newZoom,
      };
      transformRef.current = t;
      return t;
    });
  }, []);

  const handleFitToScreen = useCallback(() => {
    if (!bbox) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const t = fitToScreen(bbox, canvas.width / dpr, canvas.height / dpr);
    setTransform(t);
    transformRef.current = t;
    // Reset orbit
    tiltRef.current = { rotX: 0, rotY: 0 };
    if (canvasRef.current) canvasRef.current.style.transform = 'rotateX(0deg) rotateY(0deg)';
    if (liftCanvasRef.current) liftCanvasRef.current.style.transform = 'rotateX(0deg) rotateY(0deg) translateZ(0px)';
  }, [bbox]);

  // ── Drag and drop ─────────────────────────────────────────────────────────

  const onDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); }, []);
  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const fmt = (n) => {
    if (n >= 1000) return n.toFixed(1);
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(4);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1> PlasmaViewer</h1>
          <span className="subtitle">DXF Simulator</span>
        </div>

        {/* AdSense — sidebar top ad unit */}
        <div className="ad-slot ad-sidebar">
          <ins className="adsbygoogle"
            style={{ display: 'block' }}
            data-ad-client="ca-pub-6659416446849931"
            data-ad-slot="9480748939"
            data-ad-format="auto"
            data-full-width-responsive="true" />
        </div>

        <div className="sidebar-section">
          <label className="upload-btn">
            📂 Open DXF File
            <input
              type="file"
              accept=".dxf"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(e.target.files[0])}
            />
          </label>
        </div>

        {error && <div className="error-msg">{error}</div>}

        {fileName && (
          <>
            <div className="sidebar-section">
              <h2>File Info</h2>
              <div className="info-row"><span>File:</span><span>{fileName}</span></div>
              <div className="info-row"><span>Entities:</span><span>{entityCount}</span></div>
            </div>

            <div className="sidebar-section">
              <h2>Metrics</h2>
              <div className="info-row">
                <span>Cut Length:</span>
                <span>{fmt(cutLength)} units</span>
              </div>
              {bbox && (
                <>
                  <div className="info-row">
                    <span>Width:</span>
                    <span>{fmt(bbox.width)} units</span>
                  </div>
                  <div className="info-row">
                    <span>Height:</span>
                    <span>{fmt(bbox.height)} units</span>
                  </div>
                </>
              )}
            </div>

            <div className="sidebar-section">
              <h2>Health</h2>
              {issues.length === 0 ? (
                <div className="check-ok">✓ Looks good</div>
              ) : (
                <div className="issues-list">
                  {(() => {
                    const open = issues.filter(i => i.type === 'open-contour').length;
                    const dup = issues.filter(i => i.type === 'duplicate').length;
                    const gap = issues.filter(i => i.type === 'tiny-gap').length;
                    return (
                      <>
                        {open > 0 && <div className="issue-row error">{open} open contour{open > 1 ? 's' : ''}</div>}
                        {dup > 0 && <div className="issue-row warning">{dup} duplicate{dup > 1 ? 's' : ''}</div>}
                        {gap > 0 && <div className="issue-row warning">{gap} tiny gap{gap > 1 ? 's' : ''}</div>}
                      </>
                    );
                  })()}
                </div>
              )}
              <div className="info-row" style={{marginTop: 6}}>
                <span>Loops:</span>
                <span>{loops.filter(l => l.type === 'outside').length} outer, {loops.filter(l => l.type === 'inside').length} hole{loops.filter(l => l.type === 'inside').length !== 1 ? 's' : ''}</span>
              </div>
            </div>

            <div className="sidebar-section">
              <button className="action-btn" onClick={handleFitToScreen}>
                ⊞ Fit to Screen
              </button>
              {issues.length > 0 && (
                <button className="action-btn export-btn" onClick={() => {
                  const dxfStr = exportCleanedDxf(geometry, issues);
                  const blob = new Blob([dxfStr], { type: 'application/dxf' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  const base = fileName.replace(/\.dxf$/i, '');
                  a.download = `${base}_cleaned.dxf`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}>
                  Export Cleaned DXF
                </button>
              )}
            </div>

            <div className="sidebar-section">
              <h2>Simulation</h2>
              {!simActive ? (
                <button className="sim-btn" onClick={handleSimulate}>
                   Simulate Cut
                </button>
              ) : (
                <button className="sim-btn stop" onClick={handleStopSim}>
                  ⏹ Stop
                </button>
              )}
              <div className="kerf-control">
                <span className="speed-label">Speed:</span>
                <input
                  type="range"
                  min="0.5"
                  max="20"
                  step="0.5"
                  value={simSpeed}
                  onChange={(e) => { const v = parseFloat(e.target.value); setSimSpeed(v); simSpeedRef.current = v; }}
                  className="kerf-slider"
                />
                <span className="kerf-value">{simSpeed}x</span>
              </div>
              <div className="kerf-control">
                <span className="speed-label">Kerf:</span>
                <input
                  type="range"
                  min="1"
                  max="8"
                  step="0.5"
                  value={kerf}
                  onChange={(e) => setKerf(parseFloat(e.target.value))}
                  className="kerf-slider"
                />
                <span className="kerf-value">{kerf}px</span>
              </div>
            </div>
          </>
        )}

        <div className="sidebar-footer">
          <small>Scroll to zoom · Drag to pan · Middle-click to orbit</small>
        </div>
      </aside>

      <div
        className="viewport"
        ref={containerRef}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={{ perspective: '1200px' }}
      >
        <canvas
          ref={canvasRef}
          style={{ transformStyle: 'preserve-3d' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        <canvas
          ref={liftCanvasRef}
          className="lift-canvas"
          style={{ transformStyle: 'preserve-3d' }}
        />
        {simHud && (
          <div className="sim-hud">
            <span className="sim-hud-label" style={{ color: simHud.color }}>{simHud.label}</span>
            <div className="sim-hud-bar-bg">
              <div className="sim-hud-bar" ref={barRef} style={{ width: `${simHud.progress * 100}%`, backgroundColor: simHud.color }} />
            </div>
          </div>
        )}
        {!fileName && (
          <div className="drop-overlay">
            <div className="drop-text">
              <span className="drop-icon">📐</span>
              <p>Drop a DXF file here</p>
              <p className="drop-sub">or use the sidebar to upload</p>
            </div>
          </div>
        )}

        {/* SEO content — visible to crawlers, shown when no file loaded */}
        {!fileName && (
          <div className="seo-content" role="complementary">
            <h2>Free Online DXF Viewer &amp; Plasma Cut Simulator</h2>
            <p>
              PlasmaViewer lets you preview DXF files directly in your browser — no download or install needed.
              Simulate plasma cuts with real-time animation, detect open contours and duplicate entities,
              measure cut length, and export cleaned DXF files ready for your CNC plasma table.
            </p>
            <h3>Features</h3>
            <ul>
              <li>Instant DXF file viewing with pan &amp; zoom</li>
              <li>Real-time plasma cut simulation with adjustable speed</li>
              <li>Automatic health checks: open contours, duplicates, tiny gaps</li>
              <li>Inside/outside loop detection for proper cutting order</li>
              <li>Kerf width adjustment for accurate preview</li>
              <li>One-click cleaned DXF export with fixes applied</li>
              <li>Works on desktop and mobile — no software to install</li>
            </ul>
          </div>
        )}

        {/* AdSense — bottom banner */}
        <div className="ad-slot ad-bottom">
          <ins className="adsbygoogle"
            style={{ display: 'block' }}
            data-ad-client="ca-pub-6659416446849931"
            data-ad-slot="9480748939"
            data-ad-format="horizontal"
            data-full-width-responsive="true" />
        </div>
      </div>
    </div>
  );
}
