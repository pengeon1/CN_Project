/**
 * @fileoverview Main canvas viewport with razor-sharp dot-grid background,
 * high-DPI (Retina) scaling, panning, zooming, real-time freehand stroke rendering
 * using perfect-freehand, batched transmission, throttled cursor broadcasting,
 * remote live cursors with name tags, stroke-level eraser with point-to-segment hit testing,
 * and author hover attribution.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus, Radio, RotateCcw } from 'lucide-react';
import { getStroke } from 'perfect-freehand';
import {
  type AnchorRef,
  CURSOR_THROTTLE_MS,
  canMutateCanvas,
  isHost,
  type ObjectChanges,
  PRESENTATION_HEARTBEAT_MS,
  type Point,
  type RemoteCursor,
  STROKE_BATCH_INTERVAL_MS,
  type ShapeObject,
  type StrokeObject,
  type WhiteboardObject,
  applyObjectChanges,
} from '@cn-whiteboard/common';
import { consumeRemoteLaserPoints, useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts.js';
import { getImageElement, renderImage } from './images.js';
import { insertImageFile } from './imageInsert.js';
import {
  type AnchorPoint,
  type Bounds,
  type HandleId,
  computeResizedObjectChanges,
  defaultShapeAlign,
  findNearestAnchor,
  fontOf,
  getBounds,
  getObjectAnchors,
  hitTest,
  isCenteredShape,
  isLinear,
  lighten,
  moveChanges,
  pickHandle,
  pickTextTarget,
  pickTopmost,
  recomputeBoundConnector,
  renderSelection,
  renderShape,
  shapeTextColor,
  stickyFill,
} from './shapes.js';

/** Default sizes (world units) for shapes created with a plain click instead of a drag. */
const DEFAULT_SIZE = {
  rectangle: { w: 140, h: 90 },
  ellipse: { w: 140, h: 90 },
  line: { w: 140, h: 0 },
  arrow: { w: 140, h: 0 },
  connector: { w: 140, h: 60 },
  text: { w: 220, h: 40 },
  sticky_note: { w: 180, h: 180 },
} as const;

type ShapeTool = keyof typeof DEFAULT_SIZE;
const isShapeTool = (t: string): t is ShapeTool => t in DEFAULT_SIZE;

/** Active pointer interaction on the select tool (kept in a ref; preview lives in state). */
type DragState =
  | { kind: 'move'; sx: number; sy: number; ids: string[]; moved: boolean }
  | { kind: 'resize'; id: string; handle: HandleId }
  | { kind: 'create'; sx: number; sy: number; tool: ShapeTool; startAnchor?: AnchorRef };

/** Inline editor for text boxes, sticky notes and text inside shapes. */
interface EditorState {
  /** Existing object being edited, or null while composing a brand-new one. */
  id: string | null;
  base: ShapeObject;
}

interface HoveredAuthorInfo {
  strokeId: string;
  isStroke: boolean;
  authorName: string;
  authorColor: string;
  screenX: number;
  screenY: number;
}

const ERASER_RADIUS = 16;
/** How long a laser trail stays visible after the pointer moves on. */
const LASER_TTL_MS = 900;

interface LaserTrail {
  color: string;
  pts: Array<{ x: number; y: number; t: number }>;
}

/** Appends a world-space point to a user's laser trail unless the pointer has not moved. */
function addLaserPoint(
  trails: Map<string, LaserTrail>,
  id: string,
  color: string,
  x: number,
  y: number,
  t: number,
): void {
  let trail = trails.get(id);
  if (!trail) {
    trail = { color, pts: [] };
    trails.set(id, trail);
  }
  trail.color = color;
  const last = trail.pts[trail.pts.length - 1];
  if (!last || last.x !== x || last.y !== y) trail.pts.push({ x, y, t });
}

/** Draws a fading glowing trail ending in a bright dot (screen space) using quadratic spline interpolation. */
function renderLaserTrail(
  ctx: CanvasRenderingContext2D,
  trail: LaserTrail,
  zoom: number,
  panX: number,
  panY: number,
  now: number,
): void {
  const pts = trail.pts;
  if (pts.length === 0) return;

  const toScreen = (pt: { x: number; y: number }) => ({
    x: (pt.x + panX) * zoom,
    y: (pt.y + panY) * zoom,
  });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = trail.color;
  ctx.shadowColor = trail.color;
  ctx.shadowBlur = 12;

  if (pts.length === 2) {
    const a = toScreen(pts[0]!);
    const b = toScreen(pts[1]!);
    const alpha = Math.max(0, 1 - (now - pts[1]!.t) / LASER_TTL_MS);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2 + 3 * alpha;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  } else if (pts.length >= 3) {
    // Midpoint quadratic Bézier spline ensures smooth curves even when network updates arrive sparsely
    for (let i = 1; i < pts.length - 1; i++) {
      const pPrev = pts[i - 1]!;
      const pCurr = pts[i]!;
      const pNext = pts[i + 1]!;

      const sWorld = i === 1 ? pPrev : { x: (pPrev.x + pCurr.x) / 2, y: (pPrev.y + pCurr.y) / 2 };
      const eWorld =
        i === pts.length - 2 ? pNext : { x: (pCurr.x + pNext.x) / 2, y: (pCurr.y + pNext.y) / 2 };

      const s = toScreen(sWorld);
      const ctrl = toScreen(pCurr);
      const e = toScreen(eWorld);

      const alpha = Math.max(0, 1 - (now - pCurr.t) / LASER_TTL_MS);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2 + 3.5 * alpha;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, e.x, e.y);
      ctx.stroke();
    }
  }

  const head = pts[pts.length - 1];
  if (head) {
    const hs = toScreen(head);
    ctx.globalAlpha = Math.max(0, 1 - (now - head.t) / LASER_TTL_MS);
    ctx.fillStyle = trail.color;
    ctx.beginPath();
    ctx.arc(hs.x, hs.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(hs.x, hs.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Renders a single freehand stroke onto the 2D canvas using perfect-freehand outline polygon.
 */
export function renderStroke(
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

export const WhiteboardCanvas: React.FC = () => {
  const {
    zoom,
    panX,
    panY,
    setZoom,
    zoomBy,
    zoomIn,
    zoomOut,
    adjustPan,
    resetView,
    isDarkTheme,
    activeTool,
    objects,
    liveLocalStroke,
    remoteCursors,
    participants,
    currentUser,
    roomInfo,
    showRemoteCursors,
    startDrawing,
    updateLocalLivePoint,
    appendDrawingPoints,
    finishDrawing,
    broadcastCursorPosition,
    eraseObjects,
    selectedIds,
    imageData,
    ensureImages,
    setSelectedIds,
    setPan,
    presentation,
    sendPresentationViewport,
    endStalePresentation,
    setActiveTool,
    addShape,
    updateObjects,
    deleteObjects,
    toolProps,
    activeTextEditor,
    textEditRequestId,
    textEditCommitCount,
    setActiveTextEditor,
    requestTextEdit,
  } = useWhiteboardStore();

  const canEdit =
    !currentUser ||
    (canMutateCanvas(currentUser.role) && (!roomInfo?.locked || isHost(currentUser.role)));

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

  // Select/shape interaction state
  const dragRef = useRef<DragState | null>(null);
  /** Local-only geometry overrides while dragging; committed as OBJECT_UPDATE on pointer-up. */
  const [preview, setPreview] = useState<Record<string, WhiteboardObject>>({});
  const [draft, setDraft] = useState<ShapeObject | null>(null);
  const [snapAnchor, setSnapAnchor] = useState<AnchorPoint | null>(null);
  const [connectorHoverObjId, setConnectorHoverObjId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [imageTick, setImageTick] = useState(0);
  const laserTrails = useRef<Map<string, LaserTrail>>(new Map());
  const laserTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLaserPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const laserFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRemoteLaserCoordsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const lastPresentSend = useRef(0);

  // Presentation: the host drives; everyone else has a locked, mirrored view.
  const amHost = currentUser ? isHost(currentUser.role) : false;
  const presenting = presentation.active && amHost;
  const following = presentation.active && !amHost;
  const [editorText, setEditorText] = useState('');
  const editorClosedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Automatically focus and select textarea when editor opens
  useEffect(() => {
    if (editor) {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const val = textareaRef.current.value;
          textareaRef.current.setSelectionRange(val.length, val.length);
        }
      });
    }
  }, [editor]);

  // Clear connector hover/snap UI when switching away from the connector tool
  useEffect(() => {
    if (activeTool !== 'connector') {
      setSnapAnchor(null);
      setConnectorHoverObjId(null);
    }
  }, [activeTool]);

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
        if (hitTest(obj, worldX, worldY, threshold)) {
          hitIds.push(obj.id);
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

    // Draw every committed object in z-order; drag previews override the stored geometry.
    const drawList = Object.values(objects)
      .map((o) => preview[o.id] ?? o)
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const obj of drawList) {
      if (obj.type === 'stroke') {
        renderStroke(ctx, obj, hoveredAuthor?.strokeId === obj.id);
      } else if (obj.type === 'image') {
        renderImage(
          ctx,
          obj,
          getImageElement(obj.assetId, imageData[obj.assetId], () => setImageTick((t) => t + 1)),
        );
      } else {
        renderShape(ctx, obj, editor?.id === obj.id);
      }
    }
    if (draft) renderShape(ctx, draft);

    const selected = selectedIds
      .map((id) => (objects[id] ? (preview[id] ?? objects[id]) : null))
      .filter((o): o is WhiteboardObject => o !== null);
    for (const obj of selected) {
      renderSelection(ctx, obj, zoom, selected.length === 1);
    }

    // Connector magnetic edge anchors & active snap ring
    if (activeTool === 'connector' && !following) {
      const hoverObj = connectorHoverObjId
        ? (preview[connectorHoverObjId] ?? objects[connectorHoverObjId])
        : null;
      if (hoverObj) {
        const anchors = getObjectAnchors(hoverObj);
        for (const pt of anchors) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4.5 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.lineWidth = 1.75 / zoom;
          ctx.strokeStyle = '#2563EB';
          ctx.stroke();
          ctx.restore();
        }
      }

      if (draft?.startAnchor && objects[draft.startAnchor.objectId]) {
        const startAnchors = getObjectAnchors(objects[draft.startAnchor.objectId]!);
        const startPt = startAnchors.find((a) => a.side === draft.startAnchor!.side);
        if (startPt) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(startPt.x, startPt.y, 5 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = '#2563EB';
          ctx.fill();
          ctx.restore();
        }
      }

      if (snapAnchor) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(snapAnchor.x, snapAnchor.y, 10 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(snapAnchor.x, snapAnchor.y, 5.5 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = '#2563EB';
        ctx.fill();
        ctx.lineWidth = 1.5 / zoom;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
        ctx.restore();
      }
    }

    // Render active local in-progress stroke with 60 FPS optimistic smoothness
    if (liveLocalStroke) {
      renderStroke(ctx, liveLocalStroke, false);
    }

    ctx.restore();

    // 4. Screen space elements (remote cursors & labels remain constant physical size)
    const nowMs = Date.now();
    for (const cursor of Object.values(remoteCursors)) {
      if (cursor.activeTool === 'laser') {
        const queuedPts = consumeRemoteLaserPoints(cursor.userId);
        if (queuedPts.length > 0) {
          for (const qp of queuedPts) {
            addLaserPoint(laserTrails.current, cursor.userId, qp.color, qp.x, qp.y, qp.t);
          }
          const lastQp = queuedPts[queuedPts.length - 1]!;
          lastRemoteLaserCoordsRef.current.set(cursor.userId, { x: lastQp.x, y: lastQp.y });
        } else {
          const prev = lastRemoteLaserCoordsRef.current.get(cursor.userId);
          if (!prev || prev.x !== cursor.x || prev.y !== cursor.y) {
            addLaserPoint(
              laserTrails.current,
              cursor.userId,
              cursor.color,
              cursor.x,
              cursor.y,
              nowMs,
            );
            lastRemoteLaserCoordsRef.current.set(cursor.userId, { x: cursor.x, y: cursor.y });
          }
        }
        continue; // drawn as a laser below instead of an arrow
      }
      lastRemoteLaserCoordsRef.current.delete(cursor.userId);
      if (showRemoteCursors) {
        const sx = (cursor.x + panX) * zoom;
        const sy = (cursor.y + panY) * zoom;
        if (sx >= -50 && sx <= width + 50 && sy >= -50 && sy <= height + 50) {
          renderRemoteCursor(ctx, cursor, sx, sy);
        }
      }
    }

    // Laser pointers (local and remote): fade out at 60 FPS, and keep repainting until they are gone
    let trailAlive = false;
    for (const [id, trail] of laserTrails.current) {
      trail.pts = trail.pts.filter((p) => nowMs - p.t < LASER_TTL_MS);
      if (trail.pts.length === 0) {
        laserTrails.current.delete(id);
        continue;
      }
      trailAlive = true;
      renderLaserTrail(ctx, trail, zoom, panX, panY, nowMs);
      const owner = remoteCursors[id];
      const head = trail.pts[trail.pts.length - 1]!;
      if (owner) {
        ctx.save();
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = trail.color;
        ctx.fillText(owner.username, (head.x + panX) * zoom + 12, (head.y + panY) * zoom - 10);
        ctx.restore();
      }
    }
    if (trailAlive && laserTimer.current === null) {
      laserTimer.current = setTimeout(() => {
        laserTimer.current = null;
        setImageTick((t) => t + 1);
      }, 16);
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
    preview,
    draft,
    snapAnchor,
    connectorHoverObjId,
    editor,
    selectedIds,
    showRemoteCursors,
    imageData,
    imageTick,
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

  // Cleanup pending laser timers on unmount
  useEffect(() => {
    return () => {
      if (laserTimer.current) clearTimeout(laserTimer.current);
      if (laserFlushTimerRef.current) clearTimeout(laserFlushTimerRef.current);
    };
  }, []);

  /** Builds a not-yet-sent shape from the active tool properties. */
  const buildShape = (
    tool: ShapeTool,
    x: number,
    y: number,
    w: number,
    h: number,
    startAnchor?: AnchorRef,
    endAnchor?: AnchorRef,
  ): ShapeObject => {
    const linear = tool === 'line' || tool === 'arrow' || tool === 'connector';
    const box = !linear;
    return {
      id: 'draft',
      type: 'shape',
      authorId: currentUser?.id ?? 'local',
      seq: 0,
      zIndex: 0,
      updatedAt: Date.now(),
      shapeType: tool,
      x: box ? Math.min(x, x + w) : x,
      y: box ? Math.min(y, y + h) : y,
      width: box ? Math.abs(w) : w,
      height: box ? Math.abs(h) : h,
      strokeColor: toolProps.color,
      strokeWidth: tool === 'text' || tool === 'sticky_note' ? 0 : toolProps.width,
      fillColor:
        tool === 'sticky_note'
          ? stickyFill(toolProps.color)
          : toolProps.fill && (tool === 'rectangle' || tool === 'ellipse')
            ? (toolProps.fillColor ?? lighten(toolProps.color, 0.75))
            : undefined,
      fontSize: toolProps.fontSize,
      fontFamily: toolProps.fontFamily,
      bold: toolProps.bold,
      italic: toolProps.italic,
      align: isCenteredShape(tool) ? (toolProps.shapeAlign ?? 'center') : toolProps.align,
      ...(startAnchor ? { startAnchor } : {}),
      ...(endAnchor ? { endAnchor } : {}),
    };
  };

  /** Computes move changes for selected objects plus any attached bound connectors. */
  const computeMovedObjects = (
    ids: string[],
    dx: number,
    dy: number,
  ): Record<string, ObjectChanges> => {
    const idSet = new Set(ids);
    const changesById: Record<string, ObjectChanges> = {};
    const merged: Record<string, WhiteboardObject> = { ...objects };

    for (const id of ids) {
      const o = objects[id];
      if (!o) continue;
      // If a connector's attached box is also being moved, let recomputeBoundConnector track it instead of detaching
      if (
        o.type === 'shape' &&
        o.shapeType === 'connector' &&
        ((o.startAnchor && idSet.has(o.startAnchor.objectId)) ||
          (o.endAnchor && idSet.has(o.endAnchor.objectId)))
      ) {
        continue;
      }
      const ch = moveChanges(o, dx, dy);
      changesById[id] = ch;
      merged[id] = applyObjectChanges(o, ch, o.seq, o.updatedAt);
    }

    for (const obj of Object.values(objects)) {
      if (obj.type === 'shape' && obj.shapeType === 'connector') {
        const startAffected = obj.startAnchor && obj.startAnchor.objectId in changesById;
        const endAffected = obj.endAnchor && obj.endAnchor.objectId in changesById;
        if (startAffected || endAffected) {
          const ch = recomputeBoundConnector(obj, merged);
          if (ch) changesById[obj.id] = ch;
        }
      }
    }
    return changesById;
  };

  /** Finishes a create-drag: text/sticky open the editor, other shapes are sent immediately. */
  const finishCreate = (drag: Extract<DragState, { kind: 'create' }>, x: number, y: number) => {
    setDraft(null);
    setSnapAnchor(null);
    setConnectorHoverObjId(null);

    let endX = x;
    let endY = y;
    let endAnchor: AnchorRef | undefined;
    if (drag.tool === 'connector') {
      const endSnap = findNearestAnchor(objects, x, y, 22 / zoom, drag.startAnchor?.objectId);
      if (endSnap) {
        endX = endSnap.x;
        endY = endSnap.y;
        endAnchor = { objectId: endSnap.objectId, side: endSnap.side };
      }
    }

    const dx = endX - drag.sx;
    const dy = endY - drag.sy;
    const tiny = Math.hypot(dx, dy) * zoom < 6;
    const def = DEFAULT_SIZE[drag.tool];
    const shape = tiny
      ? buildShape(drag.tool, drag.sx, drag.sy, def.w, def.h, drag.startAnchor)
      : buildShape(drag.tool, drag.sx, drag.sy, dx, dy, drag.startAnchor, endAnchor);

    if (drag.tool === 'sticky_note') {
      const id = addShape({ ...shape, text: '' });
      if (id) {
        const created = { ...shape, id, text: '' };
        setSelectedIds([id]);
        editorClosedRef.current = false;
        setEditorText('');
        setEditor({
          id,
          base: created,
        });
        syncActiveEditorStore(id, created);
      }
      return;
    }

    if (drag.tool === 'text') {
      if (tiny) {
        const hitShape = pickTextTarget(objects, drag.sx, drag.sy, 8 / zoom);
        if (hitShape) {
          setSelectedIds([hitShape.id]);
          beginEdit(hitShape);
          return;
        }
      }
      const nextBase = tiny ? shape : { ...shape, height: Math.max(shape.height, 40) };
      editorClosedRef.current = false;
      setEditorText('');
      setEditor({
        id: null,
        base: nextBase,
      });
      syncActiveEditorStore(null, nextBase);
      return;
    }
    const id = addShape(shape);
    if (id) setSelectedIds([id]);
    setActiveTool('select');
  };

  const syncActiveEditorStore = useCallback(
    (objectId: string | null, base: ShapeObject) => {
      if (
        base.shapeType !== 'rectangle' &&
        base.shapeType !== 'ellipse' &&
        base.shapeType !== 'sticky_note' &&
        base.shapeType !== 'text'
      ) {
        return;
      }
      setActiveTextEditor({
        objectId,
        shapeType: base.shapeType,
        strokeColor: base.strokeColor,
        fillColor: base.fillColor,
        fontSize: base.fontSize ?? 16,
        fontFamily: base.fontFamily ?? 'Inter, sans-serif',
        bold: Boolean(base.bold),
        italic: Boolean(base.italic),
        align: base.align ?? defaultShapeAlign(base.shapeType),
      });
    },
    [setActiveTextEditor],
  );

  /** Opens the inline editor on an existing text-capable object. */
  const beginEdit = (obj: WhiteboardObject) => {
    if (obj.type !== 'shape' || isLinear(obj)) return;
    const base: ShapeObject =
      isCenteredShape(obj.shapeType) && !obj.text && obj.align === undefined
        ? { ...obj, align: 'center' }
        : obj;
    editorClosedRef.current = false;
    setEditorText(base.text ?? '');
    setEditor({ id: base.id, base });
    syncActiveEditorStore(base.id, base);
  };

  /** Commits (or discards) the inline editor; guarded so blur + Enter cannot double-fire. */
  const closeEditor = (commit: boolean) => {
    if (!editor || editorClosedRef.current) return;
    editorClosedRef.current = true;
    const text = editorText;
    const live = useWhiteboardStore.getState().activeTextEditor;
    const base: ShapeObject = live
      ? {
          ...editor.base,
          strokeColor: live.strokeColor,
          fillColor: live.fillColor,
          fontSize: live.fontSize,
          fontFamily: live.fontFamily,
          bold: live.bold,
          italic: live.italic,
          align: live.align,
        }
      : editor.base;
    setEditor(null);
    setActiveTextEditor(null);
    setActiveTool('select');
    if (!commit) return;

    // Text boxes grow with their content; sticky notes and shapes keep their size.
    const lines = text.split('\n').length;
    const grownHeight =
      base.shapeType === 'text'
        ? Math.max(40, Math.ceil(lines * (base.fontSize ?? 16) * 1.3 + 12))
        : base.height;

    if (editor.id) {
      const needsCenteredAlignPersist = editor.base.align !== base.align && text.trim() !== '';
      if (text === (editor.base.text ?? '') && !needsCenteredAlignPersist) return;
      updateObjects([editor.id], () => ({
        text,
        ...(needsCenteredAlignPersist ? { align: base.align } : {}),
        ...(base.shapeType === 'text' ? { height: grownHeight } : {}),
      }));
    } else if (text.trim() !== '') {
      const id = addShape({ ...base, text, height: grownHeight });
      if (id) setSelectedIds([id]);
    }
  };

  const beginEditRef = useRef(beginEdit);
  beginEditRef.current = beginEdit;
  const closeEditorRef = useRef(() => closeEditor(true));
  closeEditorRef.current = () => closeEditor(true);

  useEffect(() => {
    if (!textEditRequestId) return;
    requestTextEdit(null);
    const target = objects[textEditRequestId];
    if (target && target.type === 'shape' && !isLinear(target)) {
      setSelectedIds([target.id]);
      beginEditRef.current(target);
    }
  }, [textEditRequestId, objects, requestTextEdit, setSelectedIds]);

  const lastCommitCountRef = useRef(textEditCommitCount);
  useEffect(() => {
    if (textEditCommitCount !== lastCommitCountRef.current) {
      lastCommitCountRef.current = textEditCommitCount;
      closeEditorRef.current();
    }
  }, [textEditCommitCount]);

  useEffect(() => () => setActiveTextEditor(null), [setActiveTextEditor]);

  // Follower: mirror the host's view, keeping the host's centre point centred in OUR window
  useEffect(() => {
    const view = presentation.viewport;
    const el = containerRef.current;
    if (!following || !view || !el) return;
    const rect = el.getBoundingClientRect();
    setZoom(view.zoom);
    const z = useWhiteboardStore.getState().zoom;
    setPan(rect.width / (2 * z) - view.x, rect.height / (2 * z) - view.y);
  }, [following, presentation, setZoom, setPan]);

  // Presenter: broadcast the centre of the view (rate-limited, trailing edge), plus a heartbeat
  const sendView = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = useWhiteboardStore.getState();
    sendPresentationViewport(
      rect.width / (2 * s.zoom) - s.panX,
      rect.height / (2 * s.zoom) - s.panY,
      s.zoom,
    );
  }, [sendPresentationViewport]);

  useEffect(() => {
    if (!presenting) return;
    const wait = Math.max(0, lastPresentSend.current + 50 - Date.now());
    const t = setTimeout(() => {
      lastPresentSend.current = Date.now();
      sendView();
    }, wait);
    return () => clearTimeout(t);
  }, [presenting, zoom, panX, panY, sendView]);

  useEffect(() => {
    if (!presenting) return;
    const i = setInterval(sendView, PRESENTATION_HEARTBEAT_MS);
    return () => clearInterval(i);
  }, [presenting, sendView]);

  // Follower safety net: a presentation whose host went silent ends by itself
  useEffect(() => {
    const i = setInterval(endStalePresentation, 2000);
    return () => clearInterval(i);
  }, [endStalePresentation]);

  // Fetch bytes for any image on the board we do not have yet (late join, resync, new upload).
  useEffect(() => {
    ensureImages();
    const timer = setInterval(ensureImages, 5000);
    return () => clearInterval(timer);
  }, [objects, ensureImages]);

  // Paste an image from the clipboard
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableElement(e.target)) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith('image/'),
      );
      if (file) {
        e.preventDefault();
        void insertImageFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    void insertImageFile(file, screenToWorld(e.clientX, e.clientY));
  };

  // Delete / Escape on the canvas (ignored while typing in any input or the inline editor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        deleteObjects(selectedIds);
        e.preventDefault();
      } else if (e.key === 'Escape' && selectedIds.length > 0) {
        setSelectedIds([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, deleteObjects, setSelectedIds]);

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'select' && activeTool !== 'text' && activeTool !== 'sticky_note') return;
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    const hit = pickTextTarget(objects, x, y, 8 / zoom);
    if (hit) {
      setSelectedIds([hit.id]);
      beginEdit(hit);
    }
  };

  const editorBounds: Bounds | null = editor ? getBounds(editor.base) : null;
  const effectiveEditorBase: ShapeObject | null = editor
    ? activeTextEditor
      ? {
          ...editor.base,
          strokeColor: activeTextEditor.strokeColor,
          fillColor: activeTextEditor.fillColor,
          fontSize: activeTextEditor.fontSize,
          fontFamily: activeTextEditor.fontFamily,
          bold: activeTextEditor.bold,
          italic: activeTextEditor.italic,
          align: activeTextEditor.align,
        }
      : editor.base
    : null;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || !effectiveEditorBase) return;
    if (isCenteredShape(effectiveEditorBase.shapeType)) {
      el.style.height = '0px';
      const minLineH = Math.ceil((effectiveEditorBase.fontSize ?? 16) * zoom * 1.3);
      el.style.height = `${Math.max(el.scrollHeight, minLineH)}px`;
    } else {
      el.style.height = '100%';
    }
  }, [
    editor,
    editorText,
    zoom,
    effectiveEditorBase?.fontSize,
    effectiveEditorBase?.bold,
    effectiveEditorBase?.italic,
    effectiveEditorBase?.fontFamily,
    effectiveEditorBase?.align,
    effectiveEditorBase?.shapeType,
    effectiveEditorBase?.width,
  ]);

  // Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Middle click or Space/Alt + Primary triggers pan
    if (
      !following &&
      (e.button === 1 || isSpacePressedRef.current || (e.button === 0 && e.altKey))
    ) {
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

    // Shape / text / sticky tools: drag to size, or click for a default size
    if (e.button === 0 && isShapeTool(activeTool)) {
      if (editor) {
        closeEditor(true);
      }
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      if (activeTool === 'text' || activeTool === 'sticky_note') {
        const hit = pickTopmost(objects, x, y, 8 / zoom);
        if (
          hit &&
          hit.type === 'shape' &&
          (hit.shapeType === 'text' ||
            hit.shapeType === 'sticky_note' ||
            (activeTool === 'text' && !isLinear(hit)))
        ) {
          setSelectedIds([hit.id]);
          beginEdit(hit);
          e.preventDefault();
          return;
        }
      }
      if (activeTool === 'connector') {
        const startSnap = findNearestAnchor(objects, x, y, 22 / zoom);
        const sx = startSnap ? startSnap.x : x;
        const sy = startSnap ? startSnap.y : y;
        const startAnchor: AnchorRef | undefined = startSnap
          ? { objectId: startSnap.objectId, side: startSnap.side }
          : undefined;
        setSnapAnchor(startSnap);
        dragRef.current = { kind: 'create', sx, sy, tool: 'connector', startAnchor };
        setDraft(buildShape('connector', sx, sy, 0, 0, startAnchor));
        containerRef.current?.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      dragRef.current = { kind: 'create', sx: x, sy: y, tool: activeTool };
      setDraft(buildShape(activeTool, x, y, 0, 0));
      containerRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Select tool: resize handle, then body hit (move), else clear selection
    if (e.button === 0 && activeTool === 'select') {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      const sole = canEdit && selectedIds.length === 1 ? objects[selectedIds[0]!] : undefined;
      const handle = sole ? pickHandle(sole, x, y, zoom) : null;
      if (sole && handle) {
        dragRef.current = { kind: 'resize', id: sole.id, handle };
        containerRef.current?.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      const hit = pickTopmost(objects, x, y, 8 / zoom);
      if (hit) {
        let ids = selectedIds;
        if (e.shiftKey) {
          ids = ids.includes(hit.id) ? ids.filter((i) => i !== hit.id) : [...ids, hit.id];
        } else if (!ids.includes(hit.id)) {
          ids = [hit.id];
        }
        setSelectedIds(ids);
        if (canEdit && ids.includes(hit.id)) {
          dragRef.current = { kind: 'move', sx: x, sy: y, ids, moved: false };
          containerRef.current?.setPointerCapture(e.pointerId);
        }
      } else {
        setSelectedIds([]);
      }
      e.preventDefault();
      return;
    }

    // Eraser tool deletes objects on click / drag
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

    // Select/shape drags: update local previews only; the network op is sent on release
    const drag = dragRef.current;
    if (drag) {
      if (drag.kind === 'create') {
        if (drag.tool === 'connector') {
          const endSnap = findNearestAnchor(objects, x, y, 22 / zoom, drag.startAnchor?.objectId);
          const tx = endSnap ? endSnap.x : x;
          const ty = endSnap ? endSnap.y : y;
          const endAnchor: AnchorRef | undefined = endSnap
            ? { objectId: endSnap.objectId, side: endSnap.side }
            : undefined;
          setSnapAnchor(endSnap);
          setConnectorHoverObjId(endSnap ? endSnap.objectId : null);
          setDraft(
            buildShape(
              'connector',
              drag.sx,
              drag.sy,
              tx - drag.sx,
              ty - drag.sy,
              drag.startAnchor,
              endAnchor,
            ),
          );
        } else {
          setDraft(buildShape(drag.tool, drag.sx, drag.sy, x - drag.sx, y - drag.sy));
        }
      } else if (drag.kind === 'move') {
        const dx = x - drag.sx;
        const dy = y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) * zoom < 3) return;
        drag.moved = true;
        const updates = computeMovedObjects(drag.ids, dx, dy);
        const next: Record<string, WhiteboardObject> = {};
        for (const [id, ch] of Object.entries(updates)) {
          const o = objects[id];
          if (o) next[id] = applyObjectChanges(o, ch, o.seq, o.updatedAt);
        }
        setPreview(next);
      } else {
        const o = objects[drag.id];
        if (o && (o.type === 'shape' || o.type === 'image')) {
          const updates = computeResizedObjectChanges(o, drag.handle, x, y, objects);
          const next: Record<string, WhiteboardObject> = {};
          for (const [id, ch] of Object.entries(updates)) {
            const existing = objects[id];
            if (existing)
              next[id] = applyObjectChanges(existing, ch, existing.seq, existing.updatedAt);
          }
          setPreview(next);
        }
      }
    } else if (activeTool === 'connector' && !isPanning) {
      const near = findNearestAnchor(objects, x, y, 22 / zoom);
      setSnapAnchor(near);
      if (near) {
        setConnectorHoverObjId(near.objectId);
      } else {
        const hovered = pickTopmost(objects, x, y, 12 / zoom);
        setConnectorHoverObjId(hovered && getObjectAnchors(hovered).length > 0 ? hovered.id : null);
      }
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

    const laserActive = activeTool === 'laser' && canEdit;

    if (laserActive) {
      const nativeEvt = e.nativeEvent as PointerEvent & {
        getCoalescedEvents?: () => PointerEvent[];
      };
      const coalesced =
        typeof nativeEvt.getCoalescedEvents === 'function' ? nativeEvt.getCoalescedEvents() : [];
      const sampleEvents = coalesced.length > 0 ? coalesced : [e.nativeEvent];

      for (const evt of sampleEvents) {
        const pt = screenToWorld(evt.clientX, evt.clientY);
        addLaserPoint(
          laserTrails.current,
          'local',
          currentUser?.color ?? '#EF4444',
          pt.x,
          pt.y,
          now,
        );
        const lastPending = pendingLaserPointsRef.current[pendingLaserPointsRef.current.length - 1];
        if (!lastPending || Math.hypot(pt.x - lastPending.x, pt.y - lastPending.y) >= 0.5) {
          pendingLaserPointsRef.current.push({ x: pt.x, y: pt.y });
          if (pendingLaserPointsRef.current.length > 64) {
            pendingLaserPointsRef.current.shift();
          }
        }
      }
      setImageTick((t) => t + 1);
    }

    // Throttled cursor broadcast (16ms ~60Hz for laser pointer with full vertex batching)
    const throttleMs = laserActive ? 16 : CURSOR_THROTTLE_MS;
    if (now - lastCursorSendRef.current >= throttleMs) {
      if (laserFlushTimerRef.current) {
        clearTimeout(laserFlushTimerRef.current);
        laserFlushTimerRef.current = null;
      }
      const batch = laserActive ? pendingLaserPointsRef.current.splice(0, 64) : undefined;
      broadcastCursorPosition(x, y, e.pressure, batch && batch.length > 0 ? batch : undefined);
      lastCursorSendRef.current = now;
    } else if (laserActive && !laserFlushTimerRef.current) {
      laserFlushTimerRef.current = setTimeout(() => {
        laserFlushTimerRef.current = null;
        const remaining = pendingLaserPointsRef.current.splice(0, 64);
        if (remaining.length > 0) {
          const tail = remaining[remaining.length - 1]!;
          broadcastCursorPosition(tail.x, tail.y, undefined, remaining);
          lastCursorSendRef.current = Date.now();
        }
      }, 20);
    }

    // Select Tool: hit test for author hover attribution
    if (activeTool === 'select' && !isPanning && !isDrawingRef.current && !dragRef.current) {
      const closestStroke = pickTopmost(objects, x, y, 8 / zoom);

      if (closestStroke) {
        const author =
          participants.find((p) => p.id === closestStroke!.authorId) ||
          (closestStroke.authorId === currentUser?.id
            ? { username: currentUser.username, color: currentUser.color }
            : { username: 'Author', color: '#64748B' });

        const container = containerRef.current;
        const rect = container?.getBoundingClientRect();
        const screenX = e.clientX - (rect?.left || 0);
        const screenY = e.clientY - (rect?.top || 0);

        setHoveredAuthor({
          strokeId: closestStroke.id,
          isStroke: closestStroke.type === 'stroke',
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

    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may have already been released
      }
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      if (drag.kind === 'create') {
        finishCreate(drag, x, y);
      } else if (drag.kind === 'move') {
        if (drag.moved) {
          const dx = x - drag.sx;
          const dy = y - drag.sy;
          const updates = computeMovedObjects(drag.ids, dx, dy);
          const ids = Object.keys(updates);
          if (ids.length > 0) {
            updateObjects(ids, (o) => updates[o.id]!);
          }
        }
      } else {
        const o = objects[drag.id];
        if (o && (o.type === 'shape' || o.type === 'image')) {
          const updates = computeResizedObjectChanges(o, drag.handle, x, y, objects);
          const ids = Object.keys(updates);
          if (ids.length > 0) {
            updateObjects(ids, (item) => updates[item.id]!);
          }
        }
      }
      setPreview({});
      return;
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
    setSnapAnchor(null);
    setConnectorHoverObjId(null);
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

  // Zoom via Ctrl/Cmd + Wheel or two-finger trackpad pinch (centered at cursor)
  const handleWheel = (e: React.WheelEvent) => {
    if (following) return; // the presenter controls the view
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      const cx = rect ? e.clientX - rect.left : e.clientX;
      const cy = rect ? e.clientY - rect.top : e.clientY;
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      zoomBy(zoomFactor, cx, cy);
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
      onDoubleClick={handleDoubleClick}
      data-canvas-surface="true"
      tabIndex={-1}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className={`relative h-full w-full overflow-hidden touch-none outline-none ${
        isPanning
          ? 'cursor-grab active:cursor-grabbing'
          : activeTool === 'pen' || activeTool === 'laser'
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

      {/* Presentation status */}
      {(presenting || following) && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-blue-600/95 px-4 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur">
          <Radio className="h-3.5 w-3.5 animate-pulse" />
          {presenting
            ? 'You are presenting: everyone follows your view'
            : `Following ${participants.find((p) => p.role === 'HOST')?.username ?? 'the host'}'s presentation`}
        </div>
      )}

      {/* Inline text editor (text boxes, sticky notes, text inside shapes) */}
      {editor &&
        editorBounds &&
        effectiveEditorBase &&
        (() => {
          const centered = isCenteredShape(effectiveEditorBase.shapeType);
          const isSticky = effectiveEditorBase.shapeType === 'sticky_note';
          const padPx = isSticky ? 8 : Math.max(4, Math.round(6 * zoom));
          const boxLeft = (editorBounds.x + panX) * zoom + (isSticky ? 8 : 0);
          const boxTop = (editorBounds.y + panY) * zoom + (isSticky ? 8 : 0);
          const boxWidth = Math.max(
            (editorBounds.w - (isSticky ? 16 : 0)) * zoom,
            centered ? 48 : 120,
          );
          const lineCount = editorText.split('\n').length;
          const boxHeight =
            effectiveEditorBase.shapeType === 'text'
              ? Math.max(
                  (editorBounds.h - (isSticky ? 16 : 0)) * zoom,
                  (lineCount * (effectiveEditorBase.fontSize ?? 16) * 1.3 + 16) * zoom,
                  38,
                )
              : Math.max((editorBounds.h - (isSticky ? 16 : 0)) * zoom, centered ? 32 : 38);
          const textAlign =
            effectiveEditorBase.align ?? defaultShapeAlign(effectiveEditorBase.shapeType);
          const placeholder =
            effectiveEditorBase.shapeType === 'sticky_note' ? 'Type note...' : 'Type text...';

          return (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => {
                e.stopPropagation();
                if (e.target !== textareaRef.current) {
                  e.preventDefault();
                  textareaRef.current?.focus();
                }
              }}
              onClick={(e) => e.stopPropagation()}
              className={`absolute z-30 flex flex-col outline-none ${
                centered
                  ? 'justify-center ring-2 ring-blue-500/80'
                  : 'justify-start border-2 border-blue-500 rounded shadow-lg'
              }`}
              style={{
                left: boxLeft,
                top: boxTop,
                width: boxWidth,
                height: boxHeight,
                padding: centered ? padPx : 6,
                borderRadius:
                  effectiveEditorBase.shapeType === 'ellipse'
                    ? '9999px'
                    : centered
                      ? `${Math.max(4, Math.round(6 * zoom))}px`
                      : undefined,
                background: centered
                  ? 'transparent'
                  : isSticky
                    ? (effectiveEditorBase.fillColor ?? '#FDE68A')
                    : isDarkTheme
                      ? 'rgba(15, 23, 42, 0.92)'
                      : 'rgba(255, 255, 255, 0.95)',
              }}
            >
              <textarea
                ref={textareaRef}
                data-canvas-text-editor="true"
                value={editorText}
                rows={1}
                placeholder={placeholder}
                onChange={(e) => setEditorText(e.target.value)}
                onBlur={(e) => {
                  const related = e.relatedTarget;
                  if (
                    related instanceof Element &&
                    related.closest('[data-property-bar="true"]') &&
                    !related.closest('[data-property-bar-commit="true"]')
                  ) {
                    return;
                  }
                  closeEditor(true);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') {
                    closeEditor(false);
                    containerRef.current?.focus();
                  } else if (e.key === 'Enter') {
                    if (!e.shiftKey) {
                      e.preventDefault();
                      closeEditor(true);
                      containerRef.current?.focus();
                    }
                  }
                }}
                className="w-full max-h-full resize-none border-0 bg-transparent p-0 outline-none overflow-y-auto"
                style={{
                  height: centered ? undefined : '100%',
                  font: fontOf({
                    ...effectiveEditorBase,
                    fontSize: (effectiveEditorBase.fontSize ?? 16) * zoom,
                  }),
                  lineHeight: 1.3,
                  textAlign,
                  color: shapeTextColor(effectiveEditorBase),
                }}
              />
            </div>
          );
        })()}

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
          <span>
            {hoveredAuthor.isStroke ? 'Drawn' : 'Created'} by {hoveredAuthor.authorName}
          </span>
        </div>
      )}

      {/* Floating Bottom-Right Zoom Control (never overlaps PropertyBar) */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-900/95 px-2 py-1 shadow-xl backdrop-blur-xl select-none text-slate-200"
      >
        <button
          type="button"
          disabled={following}
          onClick={(e) => {
            e.stopPropagation();
            zoomOut();
          }}
          title="Zoom out (Ctrl + -)"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40 transition"
        >
          <Minus className="h-3 w-3" />
        </button>

        <button
          type="button"
          disabled={following}
          onClick={(e) => {
            e.stopPropagation();
            resetView();
          }}
          title="Reset zoom to 100% (Ctrl + 0)"
          className="px-1.5 text-xs font-mono font-semibold text-slate-200 hover:text-blue-400 disabled:opacity-40 transition"
        >
          {Math.round(zoom * 100)}%
        </button>

        <button
          type="button"
          disabled={following}
          onClick={(e) => {
            e.stopPropagation();
            zoomIn();
          }}
          title="Zoom in (Ctrl + +)"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40 transition"
        >
          <Plus className="h-3 w-3" />
        </button>

        <div className="h-3.5 w-[1px] bg-slate-800 mx-0.5" />

        <button
          type="button"
          disabled={following}
          onClick={(e) => {
            e.stopPropagation();
            resetView();
          }}
          title="Reset View"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40 transition"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};
