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
  type ShapeObject,
  type StrokeObject,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts.js';
import { getImageElement, renderImage } from './images.js';
import { insertImageFile } from './imageInsert.js';
import {
  type Bounds,
  type HandleId,
  fontOf,
  getBounds,
  hitTest,
  isLinear,
  lighten,
  moveChanges,
  pickHandle,
  pickTopmost,
  renderSelection,
  renderShape,
  resizeChanges,
  stickyFill,
  STICKY_TEXT_COLOR,
} from './shapes.js';

/** Default sizes (world units) for shapes created with a plain click instead of a drag. */
const DEFAULT_SIZE = {
  rectangle: { w: 140, h: 90 },
  ellipse: { w: 140, h: 90 },
  line: { w: 140, h: 0 },
  arrow: { w: 140, h: 0 },
  text: { w: 220, h: 40 },
  sticky_note: { w: 180, h: 180 },
} as const;

type ShapeTool = keyof typeof DEFAULT_SIZE;
const isShapeTool = (t: string): t is ShapeTool => t in DEFAULT_SIZE;

/** Active pointer interaction on the select tool (kept in a ref; preview lives in state). */
type DragState =
  | { kind: 'move'; sx: number; sy: number; ids: string[]; moved: boolean }
  | { kind: 'resize'; id: string; handle: HandleId }
  | { kind: 'create'; sx: number; sy: number; tool: ShapeTool };

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
    selectedIds,
    imageData,
    ensureImages,
    setSelectedIds,
    setActiveTool,
    addShape,
    updateObjects,
    deleteObjects,
    toolProps,
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

  // Select/shape interaction state
  const dragRef = useRef<DragState | null>(null);
  /** Local-only geometry overrides while dragging; committed as OBJECT_UPDATE on pointer-up. */
  const [preview, setPreview] = useState<Record<string, WhiteboardObject>>({});
  const [draft, setDraft] = useState<ShapeObject | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [imageTick, setImageTick] = useState(0);
  const [editorText, setEditorText] = useState('');
  const editorClosedRef = useRef(false);

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
    preview,
    draft,
    editor,
    selectedIds,
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

  /** Builds a not-yet-sent shape from the active tool properties. */
  const buildShape = (tool: ShapeTool, x: number, y: number, w: number, h: number): ShapeObject => {
    const linear = tool === 'line' || tool === 'arrow';
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
            ? lighten(toolProps.color, 0.75)
            : undefined,
      fontSize: toolProps.fontSize,
      fontFamily: toolProps.fontFamily,
      bold: toolProps.bold,
      italic: toolProps.italic,
      align: toolProps.align,
    };
  };

  /** Returns `o` with geometry changes applied locally (no seq bump; preview only). */
  const applyPreview = (
    o: WhiteboardObject,
    c: ReturnType<typeof moveChanges>,
  ): WhiteboardObject => {
    if (o.type === 'stroke') return c.points ? { ...o, points: c.points } : o;
    if (o.type === 'image') return { ...o, ...c } as WhiteboardObject;
    return { ...o, ...c, fillColor: o.fillColor } as ShapeObject;
  };

  /** Finishes a create-drag: text/sticky open the editor, other shapes are sent immediately. */
  const finishCreate = (drag: Extract<DragState, { kind: 'create' }>, x: number, y: number) => {
    setDraft(null);
    const dx = x - drag.sx;
    const dy = y - drag.sy;
    const tiny = Math.hypot(dx, dy) * zoom < 6;
    const def = DEFAULT_SIZE[drag.tool];
    const shape = tiny
      ? buildShape(drag.tool, drag.sx, drag.sy, def.w, def.h)
      : buildShape(drag.tool, drag.sx, drag.sy, dx, dy);

    if (drag.tool === 'text' || drag.tool === 'sticky_note') {
      editorClosedRef.current = false;
      setEditorText('');
      setEditor({
        id: null,
        base:
          tiny || drag.tool === 'sticky_note'
            ? shape
            : { ...shape, height: Math.max(shape.height, 40) },
      });
      return;
    }
    const id = addShape(shape);
    if (id) setSelectedIds([id]);
    setActiveTool('select');
  };

  /** Opens the inline editor on an existing text-capable object. */
  const beginEdit = (obj: WhiteboardObject) => {
    if (obj.type !== 'shape' || isLinear(obj)) return;
    editorClosedRef.current = false;
    setEditorText(obj.text ?? '');
    setEditor({ id: obj.id, base: obj });
  };

  /** Commits (or discards) the inline editor; guarded so blur + Enter cannot double-fire. */
  const closeEditor = (commit: boolean) => {
    if (!editor || editorClosedRef.current) return;
    editorClosedRef.current = true;
    const text = editorText;
    const base = editor.base;
    setEditor(null);
    if (!commit) return;

    // Text boxes grow with their content; sticky notes and shapes keep their size.
    const lines = text.split('\n').length;
    const grownHeight =
      base.shapeType === 'text'
        ? Math.max(40, Math.ceil(lines * (base.fontSize ?? 16) * 1.3 + 12))
        : base.height;

    if (editor.id) {
      if (text === (base.text ?? '')) return;
      updateObjects([editor.id], () => ({
        text,
        ...(base.shapeType === 'text' ? { height: grownHeight } : {}),
      }));
    } else if (text.trim() !== '') {
      const id = addShape({ ...base, text, height: grownHeight });
      if (id) setSelectedIds([id]);
      setActiveTool('select');
    }
  };

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
    if (activeTool !== 'select') return;
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    const hit = pickTopmost(objects, x, y, 8 / zoom);
    if (hit) {
      setSelectedIds([hit.id]);
      beginEdit(hit);
    }
  };

  const editorBounds: Bounds | null = editor ? getBounds(editor.base) : null;

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

    // Shape / text / sticky tools: drag to size, or click for a default size
    if (e.button === 0 && isShapeTool(activeTool)) {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      dragRef.current = { kind: 'create', sx: x, sy: y, tool: activeTool };
      setDraft(buildShape(activeTool, x, y, 0, 0));
      containerRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Select tool: resize handle, then body hit (move), else clear selection
    if (e.button === 0 && activeTool === 'select') {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      const sole = selectedIds.length === 1 ? objects[selectedIds[0]!] : undefined;
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
        if (ids.includes(hit.id)) {
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
        setDraft(buildShape(drag.tool, drag.sx, drag.sy, x - drag.sx, y - drag.sy));
      } else if (drag.kind === 'move') {
        const dx = x - drag.sx;
        const dy = y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) * zoom < 3) return;
        drag.moved = true;
        const next: Record<string, WhiteboardObject> = {};
        for (const id of drag.ids) {
          const o = objects[id];
          if (o) next[id] = applyPreview(o, moveChanges(o, dx, dy));
        }
        setPreview(next);
      } else {
        const o = objects[drag.id];
        if (o && o.type === 'shape') {
          setPreview({ [o.id]: applyPreview(o, resizeChanges(o, drag.handle, x, y)) });
        }
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

    // Throttled cursor broadcast
    if (now - lastCursorSendRef.current >= CURSOR_THROTTLE_MS) {
      broadcastCursorPosition(x, y, e.pressure);
      lastCursorSendRef.current = now;
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
          updateObjects(drag.ids, (o) => moveChanges(o, dx, dy));
        }
      } else {
        const o = objects[drag.id];
        if (o && o.type === 'shape') {
          updateObjects([o.id], () => resizeChanges(o, drag.handle, x, y));
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
      onDoubleClick={handleDoubleClick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
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

      {/* Inline text editor (text boxes, sticky notes, text inside shapes) */}
      {editor && editorBounds && (
        <textarea
          autoFocus
          value={editorText}
          onChange={(e) => setEditorText(e.target.value)}
          onBlur={() => closeEditor(true)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeEditor(false);
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) closeEditor(true);
          }}
          className="absolute z-30 resize-none overflow-hidden rounded border-2 border-blue-500 bg-transparent p-1 outline-none"
          style={{
            left: (editorBounds.x + panX) * zoom,
            top: (editorBounds.y + panY) * zoom,
            width: Math.max(editorBounds.w * zoom, 60),
            height: Math.max(editorBounds.h * zoom, 30),
            font: fontOf({ ...editor.base, fontSize: (editor.base.fontSize ?? 16) * zoom }),
            textAlign: editor.base.align ?? 'left',
            color:
              editor.base.shapeType === 'sticky_note' ? STICKY_TEXT_COLOR : editor.base.strokeColor,
            background: editor.base.shapeType === 'sticky_note' ? editor.base.fillColor : undefined,
          }}
        />
      )}

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
