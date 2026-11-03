/**
 * @fileoverview Main canvas viewport with razor-sharp dot-grid background,
 * high-DPI (Retina) scaling, panning, zooming, real-time freehand stroke rendering
 * using perfect-freehand, batched transmission, throttled cursor broadcasting,
 * remote live cursors with name tags, stroke-level eraser with point-to-segment hit testing,
 * and author hover attribution.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { getStroke } from 'perfect-freehand';
import {
  CURSOR_THROTTLE_MS,
  type Point,
  type RemoteCursor,
  STROKE_BATCH_INTERVAL_MS,
  type StrokeObject,
} from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts.js';

interface HoveredAuthorInfo {
  strokeId: string;
  authorName: string;
  authorColor: string;
  screenX: number;
  screenY: number;
}

const ERASER_RADIUS = 16;

/**
 * Renders a single freehand stroke onto the 2D canvas using perfect-freehand outline polygon.
 */
function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeObject,
  isHovered = false,
): void {
  if (stroke.points.length === 0) return;

  const outline = getStroke(stroke.points, {
    size: stroke.width,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: stroke.points.every((p) => p.pressure === undefined),
    last: stroke.isComplete,
  });

  if (outline.length < 2) {
    if (stroke.points.length === 1 && stroke.points[0]) {
      const pt = stroke.points[0];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    }
    return;
  }

  const firstPoint = outline[0];
  if (!firstPoint) return;
  const [x0, y0] = firstPoint;

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 0; i < outline.length; i++) {
    const curr = outline[i];
    const next = outline[(i + 1) % outline.length];
    if (!curr || !next) continue;
    const [cx, cy] = curr;
    const [nx, ny] = next;
    const mx = (cx + nx) / 2;
    const my = (cy + ny) / 2;
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  ctx.closePath();

  ctx.fillStyle = stroke.color;
  ctx.fill();

  // If selected or hovered with Select tool, draw accent halo
  if (isHovered) {
    ctx.save();
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = Math.max(2, stroke.width * 0.3);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Renders a remote user's pointer arrow and name tag in screen space coordinates.
 */
function renderRemoteCursor(
  ctx: CanvasRenderingContext2D,
  cursor: RemoteCursor,
  screenX: number,
  screenY: number,
): void {
  ctx.save();
  ctx.translate(screenX, screenY);

  // 1. Draw crisp arrow pointer
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(4.5, 11.5);
  ctx.lineTo(7.5, 18);
  ctx.lineTo(10.5, 16.5);
  ctx.lineTo(7.5, 10.5);
  ctx.lineTo(13, 10.5);
  ctx.closePath();

  ctx.fillStyle = cursor.color;
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 2. Draw user name tag pill
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  const nameText = cursor.username;
  const metrics = ctx.measureText(nameText);
  const badgeWidth = metrics.width + 12;
  const badgeHeight = 20;
  const badgeX = 14;
  const badgeY = 12;
  const radius = 4;

  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, radius);
  ctx.fillStyle = cursor.color;
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fillText(nameText, badgeX + 6, badgeY + badgeHeight / 2);

  ctx.restore();
}

/**
 * Computes square of distance from point (px, py) to line segment (vx, vy) -> (wx, wy).
 */
function distToSegmentSquared(
  px: number,
  py: number,
  vx: number,
  vy: number,
  wx: number,
  wy: number,
): number {
  const l2 = (vx - wx) * (vx - wx) + (vy - wy) * (vy - wy);
  if (l2 === 0) return (px - vx) * (px - vx) + (py - vy) * (py - vy);
  let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = vx + t * (wx - vx);
  const projY = vy + t * (wy - vy);
  return (px - projX) * (px - projX) + (py - projY) * (py - projY);
}

/**
 * Calculates shortest distance from a world point (px, py) to a stroke's path using segment tests.
 */
function getDistanceToStroke(px: number, py: number, stroke: StrokeObject): number {
  if (stroke.points.length === 0) return Infinity;
  if (stroke.points.length === 1) {
    const pt = stroke.points[0]!;
    const dx = px - pt.x;
    const dy = py - pt.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  let minDistanceSq = Infinity;
  for (let i = 0; i < stroke.points.length - 1; i++) {
    const p1 = stroke.points[i]!;
    const p2 = stroke.points[i + 1]!;
    const dSq = distToSegmentSquared(px, py, p1.x, p1.y, p2.x, p2.y);
    if (dSq < minDistanceSq) {
      minDistanceSq = dSq;
    }
  }

  return Math.sqrt(minDistanceSq);
}

export const WhiteboardCanvas: React.FC = () => {
  const {
    zoom,
    panX,
    panY,
    setZoom,
    adjustPan,
    resetView,
    isDarkTheme,
    activeTool,
    objects,
    liveLocalStroke,
    remoteCursors,
    participants,
    currentUser,
    startDrawing,
    updateLocalLivePoint,
    appendDrawingPoints,
    finishDrawing,
    broadcastCursorPosition,
    eraseObjects,
  } = useWhiteboardStore();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Navigation state
  const [isPanning, setIsPanning] = useState(false);
  const lastMousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const isSpacePressedRef = useRef(false);

  // Drawing state
  const isDrawingRef = useRef(false);
  const isErasingRef = useRef(false);
  const pendingPointsRef = useRef<Point[]>([]);
  const lastBatchSendRef = useRef<number>(0);
  const lastCursorSendRef = useRef<number>(0);

  // Pointer position for eraser reticle rendering
  const [eraserPos, setEraserPos] = useState<{ x: number; y: number } | null>(null);

  // Author attribution tooltip state
  const [hoveredAuthor, setHoveredAuthor] = useState<HoveredAuthorInfo | null>(null);

  // Listen for space key to toggle pan cursor and interaction
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isEditableElement(e.target)) {
        isSpacePressedRef.current = true;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  /**
   * Transforms screen (client) coordinates into whiteboard world coordinates.
   */
  const screenToWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const container = containerRef.current;
      if (!container) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const x = screenX / zoom - panX;
      const y = screenY / zoom - panY;
      return { x, y };
    },
    [zoom, panX, panY],
  );

  /**
   * Performs hit detection and erases any strokes within ERASER_RADIUS.
   */
  const performEraseAt = useCallback(
    (worldX: number, worldY: number) => {
      const hitIds: string[] = [];
      const threshold = ERASER_RADIUS;

      for (const obj of Object.values(objects)) {
        if (obj.type === 'stroke') {
          const dist = getDistanceToStroke(worldX, worldY, obj);
          if (dist <= threshold + obj.width / 2) {
            hitIds.push(obj.id);
          }
        }
      }

      if (hitIds.length > 0) {
        eraseObjects(hitIds);
      }
    },
    [objects, eraseObjects],
  );

  /**
   * Razor-sharp high-DPI canvas rendering routine.
   * Renders dot grid, committed strokes, live optimistic local stroke,
   * selection highlights, remote user cursors, and eraser reticle.
   */
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetBufferWidth = Math.round(width * dpr);
    const targetBufferHeight = Math.round(height * dpr);

    // Sync backing store dimensions to physical device pixels
    if (canvas.width !== targetBufferWidth || canvas.height !== targetBufferHeight) {
      canvas.width = targetBufferWidth;
      canvas.height = targetBufferHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    // Reset transform matrix and scale for device pixel ratio
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. Background fill
    ctx.fillStyle = isDarkTheme ? '#0B0F19' : '#F8FAFC';
    ctx.fillRect(0, 0, width, height);

    // 2. Adaptive dot-grid spacing (Figma/FigJam style)
    const baseGrid = 24;
    let gridSize = baseGrid * zoom;
    while (gridSize < 20) {
      gridSize *= 2;
    }
    while (gridSize > 64) {
      gridSize /= 2;
    }

    const dotRadius = 1.25;
    ctx.fillStyle = isDarkTheme ? 'rgba(148, 163, 184, 0.3)' : 'rgba(100, 116, 139, 0.35)';

    const startX = (((panX * zoom) % gridSize) + gridSize) % gridSize;
    const startY = (((panY * zoom) % gridSize) + gridSize) % gridSize;

    for (let x = startX; x < width; x += gridSize) {
      const px = Math.round(x);
      for (let y = startY; y < height; y += gridSize) {
        const py = Math.round(y);
        ctx.beginPath();
        ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3. World space transformations for whiteboard elements
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(panX, panY);

    // Sort committed strokes by zIndex
    const strokeList = Object.values(objects)
      .filter((obj): obj is StrokeObject => obj.type === 'stroke')
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const stroke of strokeList) {
      const isHovered = hoveredAuthor?.strokeId === stroke.id;
      renderStroke(ctx, stroke, isHovered);
    }

    // Render active local in-progress stroke with 60 FPS optimistic smoothness
    if (liveLocalStroke) {
      renderStroke(ctx, liveLocalStroke, false);
    }

    ctx.restore();

    // 4. Screen space elements (remote cursors & labels remain constant physical size)
    for (const cursor of Object.values(remoteCursors)) {
      const sx = (cursor.x + panX) * zoom;
      const sy = (cursor.y + panY) * zoom;
      if (sx >= -50 && sx <= width + 50 && sy >= -50 && sy <= height + 50) {
        renderRemoteCursor(ctx, cursor, sx, sy);
      }
    }

    // 5. Render eraser reticle indicator when eraser tool is active
    if (activeTool === 'eraser' && eraserPos) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(eraserPos.x, eraserPos.y, ERASER_RADIUS * zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    zoom,
    panX,
    panY,
    isDarkTheme,
    objects,
    liveLocalStroke,
    remoteCursors,
    hoveredAuthor?.strokeId,
    activeTool,
    eraserPos,
  ]);

  // Continuously request animation frame when rendering changes
  useEffect(() => {
    const animationFrameId = requestAnimationFrame(renderCanvas);
    return () => cancelAnimationFrame(animationFrameId);
  }, [renderCanvas]);

  // Window & container resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(renderCanvas);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [renderCanvas]);

  // Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Middle click or Space/Alt + Primary triggers pan
    if (e.button === 1 || isSpacePressedRef.current || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }

    // Pen tool draws freehand strokes
    if (e.button === 0 && activeTool === 'pen') {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      const pressure = e.pressure !== 0.5 && e.pressure !== 0 ? e.pressure : undefined;
      const startPoint: Point = { x, y, pressure };

      isDrawingRef.current = true;
      pendingPointsRef.current = [];
      lastBatchSendRef.current = Date.now();

      startDrawing(startPoint);
      containerRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Eraser tool deletes strokes on click / drag
    if (e.button === 0 && activeTool === 'eraser') {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      isErasingRef.current = true;
      performEraseAt(x, y);
      containerRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    const now = Date.now();

    // Panning
    if (isPanning) {
      const dx = (e.clientX - lastMousePos.current.x) / zoom;
      const dy = (e.clientY - lastMousePos.current.y) / zoom;
      adjustPan(dx, dy);
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // Track eraser reticle position in screen coordinates
    if (activeTool === 'eraser') {
      const container = containerRef.current;
      const rect = container?.getBoundingClientRect();
      const sx = e.clientX - (rect?.left || 0);
      const sy = e.clientY - (rect?.top || 0);
      setEraserPos({ x: sx, y: sy });

      if (isErasingRef.current) {
        performEraseAt(x, y);
      }
    } else if (eraserPos) {
      setEraserPos(null);
    }

    // Active Drawing
    if (isDrawingRef.current && activeTool === 'pen') {
      const pressure = e.pressure !== 0.5 && e.pressure !== 0 ? e.pressure : undefined;
      const pt: Point = { x, y, pressure };

      // Immediate optimistic local update
      updateLocalLivePoint(pt);
      pendingPointsRef.current.push(pt);

      // Batched transmission to server
      if (
        now - lastBatchSendRef.current >= STROKE_BATCH_INTERVAL_MS &&
        pendingPointsRef.current.length > 0
      ) {
        appendDrawingPoints(pendingPointsRef.current);
        pendingPointsRef.current = [];
        lastBatchSendRef.current = now;
      }
    }

    // Throttled cursor broadcast
    if (now - lastCursorSendRef.current >= CURSOR_THROTTLE_MS) {
      broadcastCursorPosition(x, y, e.pressure);
      lastCursorSendRef.current = now;
    }

    // Select Tool: hit test for author hover attribution
    if (activeTool === 'select' && !isPanning && !isDrawingRef.current) {
      let closestStroke: StrokeObject | null = null;
      let minDistance = 12; // tolerance in canvas world units

      for (const obj of Object.values(objects)) {
        if (obj.type === 'stroke') {
          const dist = getDistanceToStroke(x, y, obj);
          if (dist < minDistance) {
            minDistance = dist;
            closestStroke = obj;
          }
        }
      }

      if (closestStroke) {
        const author =
          participants.find((p) => p.id === closestStroke!.authorId) ||
          (closestStroke.authorId === currentUser?.id
            ? { username: currentUser.username, color: currentUser.color }
            : { username: 'Author', color: closestStroke.color });

        const container = containerRef.current;
        const rect = container?.getBoundingClientRect();
        const screenX = e.clientX - (rect?.left || 0);
        const screenY = e.clientY - (rect?.top || 0);

        setHoveredAuthor({
          strokeId: closestStroke.id,
          authorName: author.username,
          authorColor: author.color,
          screenX,
          screenY,
        });
      } else {
        if (hoveredAuthor) {
          setHoveredAuthor(null);
        }
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanning) {
      setIsPanning(false);
    }

    if (isErasingRef.current) {
      isErasingRef.current = false;
      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may have already been released
      }
    }

    if (isDrawingRef.current && activeTool === 'pen') {
      isDrawingRef.current = false;
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      const pressure = e.pressure !== 0.5 && e.pressure !== 0 ? e.pressure : undefined;
      const finalPoint: Point = { x, y, pressure };

      // Flush remaining batch points
      if (pendingPointsRef.current.length > 0) {
        appendDrawingPoints(pendingPointsRef.current);
        pendingPointsRef.current = [];
      }

      finishDrawing(finalPoint);
      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may have already been released
      }
    }
  };

  const handlePointerLeave = () => {
    setEraserPos(null);
    if (hoveredAuthor) {
      setHoveredAuthor(null);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDrawingRef.current) {
      isDrawingRef.current = false;
      finishDrawing();
      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    }
    isErasingRef.current = false;
    setIsPanning(false);
  };

  // Zoom via Ctrl/Cmd + Wheel or two-finger trackpad pinch
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      setZoom((prev) => prev * zoomFactor);
    } else {
      adjustPan(-e.deltaX / zoom, -e.deltaY / zoom);
    }
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      className={`relative h-full w-full overflow-hidden touch-none ${
        isPanning
          ? 'cursor-grab active:cursor-grabbing'
          : activeTool === 'pen'
            ? 'cursor-crosshair'
            : activeTool === 'eraser'
              ? 'cursor-none'
              : activeTool === 'select'
                ? 'cursor-default'
                : 'cursor-crosshair'
      }`}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full pointer-events-none"
        style={{ imageRendering: 'auto' }}
      />

      {/* Author Attribution Hover Tooltip (Active when using Select tool) */}
      {hoveredAuthor && (
        <div
          className="pointer-events-none absolute z-30 flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-slate-100 shadow-xl backdrop-blur-md transition-all duration-75 select-none"
          style={{
            left: `${hoveredAuthor.screenX + 16}px`,
            top: `${hoveredAuthor.screenY - 12}px`,
          }}
        >
          <div
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: hoveredAuthor.authorColor }}
          />
          <span>Drawn by {hoveredAuthor.authorName}</span>
        </div>
      )}

      {/* Floating Bottom-Right Zoom Control (never overlaps PropertyBar) */}
      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-900/95 px-2 py-1 shadow-xl backdrop-blur-xl select-none text-slate-200">
        <button
          onClick={() => setZoom((prev) => prev * 0.85)}
          title="Zoom out"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <Minus className="h-3 w-3" />
        </button>

        <button
          onClick={() => resetView()}
          title="Reset zoom to 100%"
          className="px-1.5 text-xs font-mono font-semibold text-slate-200 hover:text-blue-400 transition"
        >
          {Math.round(zoom * 100)}%
        </button>

        <button
          onClick={() => setZoom((prev) => prev * 1.15)}
          title="Zoom in"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <Plus className="h-3 w-3" />
        </button>

        <div className="h-3.5 w-[1px] bg-slate-800 mx-0.5" />

        <button
          onClick={() => resetView()}
          title="Reset View"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};
