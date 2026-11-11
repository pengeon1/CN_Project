/**
 * @fileoverview Rendering, hit-testing and geometry helpers for shapes, lines, arrows, text boxes
 * and sticky notes. Kept free of React so it is easy to unit test.
 *
 * Geometry convention: rectangles, ellipses, text boxes and sticky notes are stored with a
 * positive width/height. Lines and arrows run from (x, y) to (x + width, y + height) and the
 * width/height may be negative, which encodes the drag direction without extra fields.
 */

import type {
  AnchorSide,
  ImageObject,
  ObjectChanges,
  ShapeObject,
  StrokeObject,
  WhiteboardObject,
} from '@cn-whiteboard/common';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorPoint {
  objectId: string;
  side: AnchorSide;
  x: number;
  y: number;
}

export type HandleId = 'nw' | 'ne' | 'sw' | 'se';
export const HANDLE_SIZE = 8;
export const STICKY_TEXT_COLOR = '#111827';

/** True for shapes whose geometry is a directed segment / connector rather than a box. */
export function isLinear(
  obj: WhiteboardObject,
): obj is ShapeObject & { shapeType: 'line' | 'arrow' | 'connector' } {
  return (
    obj.type === 'shape' &&
    (obj.shapeType === 'line' || obj.shapeType === 'arrow' || obj.shapeType === 'connector')
  );
}

/** Returns the 4 cardinal edge anchor points of a box-like object for magnetic connector snapping. */
export function getObjectAnchors(obj: WhiteboardObject): AnchorPoint[] {
  if (obj.type === 'stroke' || isLinear(obj)) return [];
  const b = getBounds(obj);
  if (b.w < 4 && b.h < 4) return [];
  return [
    { objectId: obj.id, side: 'top', x: b.x + b.w / 2, y: b.y },
    { objectId: obj.id, side: 'right', x: b.x + b.w, y: b.y + b.h / 2 },
    { objectId: obj.id, side: 'bottom', x: b.x + b.w / 2, y: b.y + b.h },
    { objectId: obj.id, side: 'left', x: b.x, y: b.y + b.h / 2 },
  ];
}

/** Resolves the world coordinate of a specific cardinal side on an object. */
export function resolveAnchorPoint(
  obj: WhiteboardObject,
  side: AnchorSide,
): { x: number; y: number } | null {
  const anchor = getObjectAnchors(obj).find((a) => a.side === side);
  return anchor ? { x: anchor.x, y: anchor.y } : null;
}

/** Finds the closest snap anchor within `maxDist` world units of `(px, py)`. */
export function findNearestAnchor(
  objects: Record<string, WhiteboardObject>,
  px: number,
  py: number,
  maxDist: number,
  excludeObjectId?: string,
): AnchorPoint | null {
  let best: AnchorPoint | null = null;
  let bestDist = maxDist;
  for (const obj of Object.values(objects)) {
    if (obj.id === excludeObjectId) continue;
    for (const anchor of getObjectAnchors(obj)) {
      const d = Math.hypot(px - anchor.x, py - anchor.y);
      if (d <= bestDist) {
        bestDist = d;
        best = anchor;
      }
    }
  }
  return best;
}

/** Computes orthogonal elbowed waypoints for a flowchart connector shape. */
export function getConnectorWaypoints(s: ShapeObject): Array<{ x: number; y: number }> {
  const x1 = s.x;
  const y1 = s.y;
  const x2 = s.x + s.width;
  const y2 = s.y + s.height;
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (Math.abs(dx) < 2 || Math.abs(dy) < 2) {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ];
  }

  const startSide = s.startAnchor?.side;
  const endSide = s.endAnchor?.side;

  const startAxis: 'h' | 'v' =
    startSide === 'left' || startSide === 'right'
      ? 'h'
      : startSide === 'top' || startSide === 'bottom'
        ? 'v'
        : Math.abs(dx) >= Math.abs(dy)
          ? 'h'
          : 'v';

  const endAxis: 'h' | 'v' =
    endSide === 'left' || endSide === 'right'
      ? 'h'
      : endSide === 'top' || endSide === 'bottom'
        ? 'v'
        : startAxis;

  if (startAxis === 'h' && endAxis === 'v') {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
    ];
  }

  if (startAxis === 'v' && endAxis === 'h') {
    return [
      { x: x1, y: y1 },
      { x: x1, y: y2 },
      { x: x2, y: y2 },
    ];
  }

  if (startAxis === 'h') {
    const midX = x1 + dx / 2;
    return [
      { x: x1, y: y1 },
      { x: midX, y: y1 },
      { x: midX, y: y2 },
      { x: x2, y: y2 },
    ];
  }

  const midY = y1 + dy / 2;
  return [
    { x: x1, y: y1 },
    { x: x1, y: midY },
    { x: x2, y: midY },
    { x: x2, y: y2 },
  ];
}

/** Axis-aligned bounding box in world coordinates. */
export function getBounds(obj: WhiteboardObject): Bounds {
  if (obj.type === 'stroke') {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of obj.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return {
    x: Math.min(obj.x, obj.x + obj.width),
    y: Math.min(obj.y, obj.y + obj.height),
    w: Math.abs(obj.width),
    h: Math.abs(obj.height),
  };
}

/** Blends a hex color toward white; used to derive a readable sticky-note fill. */
export function lighten(hex: string, amount = 0.72): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
}

/** Sticky fill for a chosen swatch: black means "classic yellow". */
export function stickyFill(color: string): string {
  return color.toUpperCase() === '#000000' ? '#FDE68A' : lighten(color);
}

/** Distance from a point to a segment. */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  let t = l2 === 0 ? 0 : ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

/** Distance from (px,py) to the outline/body of a freehand stroke. */
export function distanceToStroke(px: number, py: number, s: StrokeObject): number {
  if (s.points.length === 0) return Infinity;
  if (s.points.length === 1) return Math.hypot(px - s.points[0]!.x, py - s.points[0]!.y);
  let min = Infinity;
  for (let i = 0; i < s.points.length - 1; i++) {
    const a = s.points[i]!;
    const b = s.points[i + 1]!;
    min = Math.min(min, distToSegment(px, py, a.x, a.y, b.x, b.y));
  }
  return min;
}

/**
 * Whether the world point hits the object within `tol` world units. Unfilled boxes are hit on
 * their outline only so that shapes can be drawn on top of each other and still selected.
 */
export function hitTest(obj: WhiteboardObject, px: number, py: number, tol: number): boolean {
  if (obj.type === 'stroke') return distanceToStroke(px, py, obj) <= tol + obj.width / 2;
  if (isLinear(obj)) {
    if (obj.shapeType === 'connector') {
      const pts = getConnectorWaypoints(obj);
      const hitTol = tol + obj.strokeWidth / 2;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (distToSegment(px, py, a.x, a.y, b.x, b.y) <= hitTol) return true;
      }
      return false;
    }
    return (
      distToSegment(px, py, obj.x, obj.y, obj.x + obj.width, obj.y + obj.height) <=
      tol + obj.strokeWidth / 2
    );
  }
  if (obj.type === 'image') {
    const ib = getBounds(obj);
    return (
      px >= ib.x - tol && px <= ib.x + ib.w + tol && py >= ib.y - tol && py <= ib.y + ib.h + tol
    );
  }
  const b = getBounds(obj);
  const solid =
    obj.fillColor !== undefined || obj.shapeType === 'text' || obj.shapeType === 'sticky_note';
  if (obj.shapeType === 'ellipse') {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rx = b.w / 2 + tol;
    const ry = b.h / 2 + tol;
    const d = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
    if (solid) return d <= 1;
    const irx = Math.max(b.w / 2 - tol, 0.001);
    const iry = Math.max(b.h / 2 - tol, 0.001);
    return d <= 1 && ((px - cx) / irx) ** 2 + ((py - cy) / iry) ** 2 >= 1;
  }
  const inOuter =
    px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol;
  if (!inOuter) return false;
  if (solid) return true;
  return !(px > b.x + tol && px < b.x + b.w - tol && py > b.y + tol && py < b.y + b.h - tol);
}

/** Topmost object under the point (highest zIndex first), or null. */
export function pickTopmost(
  objects: Record<string, WhiteboardObject>,
  px: number,
  py: number,
  tol: number,
): WhiteboardObject | null {
  let best: WhiteboardObject | null = null;
  for (const obj of Object.values(objects)) {
    if (hitTest(obj, px, py, tol) && (!best || obj.zIndex >= best.zIndex)) best = obj;
  }
  return best;
}

/** Corner handle under the point for a single selected box-like object, or null. */
export function pickHandle(
  obj: WhiteboardObject,
  px: number,
  py: number,
  zoom: number,
): HandleId | null {
  if (obj.type === 'stroke' || isLinear(obj)) return null;
  const b = getBounds(obj);
  const r = (HANDLE_SIZE / zoom) * 1.2;
  const corners: Record<HandleId, [number, number]> = {
    nw: [b.x, b.y],
    ne: [b.x + b.w, b.y],
    sw: [b.x, b.y + b.h],
    se: [b.x + b.w, b.y + b.h],
  };
  for (const id of Object.keys(corners) as HandleId[]) {
    const [cx, cy] = corners[id];
    if (Math.abs(px - cx) <= r && Math.abs(py - cy) <= r) return id;
  }
  return null;
}

/** Geometry change produced by dragging a corner handle to (px, py). Keeps a 12 unit minimum. */
export function resizeChanges(
  obj: ShapeObject | ImageObject,
  handle: HandleId,
  px: number,
  py: number,
): ObjectChanges {
  const b = getBounds(obj);
  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;
  if (handle === 'nw' || handle === 'sw') left = Math.min(px, right - 12);
  else right = Math.max(px, left + 12);
  if (handle === 'nw' || handle === 'ne') top = Math.min(py, bottom - 12);
  else bottom = Math.max(py, top + 12);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Changes that translate any object by (dx, dy). Strokes carry absolute point arrays. */
export function moveChanges(obj: WhiteboardObject, dx: number, dy: number): ObjectChanges {
  if (obj.type === 'stroke') {
    return { points: obj.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  }
  if (obj.type === 'shape' && obj.shapeType === 'connector') {
    return {
      x: obj.x + dx,
      y: obj.y + dy,
      ...(obj.startAnchor ? { startAnchor: null } : {}),
      ...(obj.endAnchor ? { endAnchor: null } : {}),
    };
  }
  return { x: obj.x + dx, y: obj.y + dy };
}

/**
 * Computes geometry updates for a bound connector whose attached boxes moved or resized.
 * Returns null if the connector is unbound or neither endpoint moved.
 */
export function recomputeBoundConnector(
  connector: ShapeObject,
  latestObjects: Record<string, WhiteboardObject>,
): ObjectChanges | null {
  if (connector.shapeType !== 'connector') return null;
  if (!connector.startAnchor && !connector.endAnchor) return null;

  let startX = connector.x;
  let startY = connector.y;
  let endX = connector.x + connector.width;
  let endY = connector.y + connector.height;
  let changed = false;

  if (connector.startAnchor) {
    const target = latestObjects[connector.startAnchor.objectId];
    if (target) {
      const pt = resolveAnchorPoint(target, connector.startAnchor.side);
      if (pt && (pt.x !== startX || pt.y !== startY)) {
        startX = pt.x;
        startY = pt.y;
        changed = true;
      }
    }
  }
  if (connector.endAnchor) {
    const target = latestObjects[connector.endAnchor.objectId];
    if (target) {
      const pt = resolveAnchorPoint(target, connector.endAnchor.side);
      if (pt && (pt.x !== endX || pt.y !== endY)) {
        endX = pt.x;
        endY = pt.y;
        changed = true;
      }
    }
  }

  if (!changed) return null;
  return {
    x: startX,
    y: startY,
    width: endX - startX,
    height: endY - startY,
  };
}

/** Changes that apply a chosen color to the right property of each object kind. */
export function colorChanges(obj: WhiteboardObject, color: string): ObjectChanges {
  if (obj.type === 'stroke') return { color };
  if (obj.type === 'image') return {};
  if (obj.shapeType === 'sticky_note') return { strokeColor: color, fillColor: stickyFill(color) };
  return { strokeColor: color };
}

/** Wraps text into lines that fit `maxWidth` using the context's current font. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

/** CSS font string for a shape's typography. */
export function fontOf(s: ShapeObject): string {
  return `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '400 '}${s.fontSize ?? 16}px ${
    s.fontFamily ?? 'Inter, system-ui, sans-serif'
  }`;
}

/** Draws wrapped text inside the shape's box, honoring alignment. */
function drawText(ctx: CanvasRenderingContext2D, s: ShapeObject, color: string): void {
  if (!s.text) return;
  const b = getBounds(s);
  const pad = s.shapeType === 'sticky_note' ? 12 : 6;
  const size = s.fontSize ?? 16;
  ctx.save();
  ctx.font = fontOf(s);
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.textAlign = s.align ?? 'left';
  const lines = wrapText(ctx, s.text, Math.max(b.w - pad * 2, 10));
  const lineH = size * 1.3;
  const total = lines.length * lineH;
  const centered = s.shapeType === 'rectangle' || s.shapeType === 'ellipse';
  let y = centered ? b.y + Math.max((b.h - total) / 2, pad) : b.y + pad;
  const x =
    s.align === 'center' ? b.x + b.w / 2 : s.align === 'right' ? b.x + b.w - pad : b.x + pad;
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineH;
  }
  ctx.restore();
}

/** Renders a shape-type object. `hideText` hides text while an inline editor overlays it. */
export function renderShape(ctx: CanvasRenderingContext2D, s: ShapeObject, hideText = false): void {
  const b = getBounds(s);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = s.strokeColor;
  ctx.lineWidth = s.strokeWidth;
  switch (s.shapeType) {
    case 'rectangle':
    case 'ellipse':
      ctx.beginPath();
      if (s.shapeType === 'rectangle') ctx.roundRect(b.x, b.y, b.w, b.h, 6);
      else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (s.fillColor) {
        ctx.fillStyle = s.fillColor;
        ctx.fill();
      }
      if (s.strokeWidth > 0) ctx.stroke();
      if (!hideText) drawText(ctx, s, s.strokeColor);
      break;
    case 'line':
    case 'arrow': {
      const x2 = s.x + s.width;
      const y2 = s.y + s.height;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (s.shapeType === 'arrow') {
        const ang = Math.atan2(s.height, s.width);
        const head = Math.max(10, s.strokeWidth * 4);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - head * Math.cos(ang - Math.PI / 6),
          y2 - head * Math.sin(ang - Math.PI / 6),
        );
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - head * Math.cos(ang + Math.PI / 6),
          y2 - head * Math.sin(ang + Math.PI / 6),
        );
        ctx.stroke();
      }
      break;
    }
    case 'connector': {
      const pts = getConnectorWaypoints(s);
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length - 1; i++) {
          const prev = pts[i - 1]!;
          const curr = pts[i]!;
          const next = pts[i + 1]!;
          const d1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
          const d2 = Math.hypot(next.x - curr.x, next.y - curr.y);
          const r = Math.min(12, d1 * 0.45, d2 * 0.45);
          if (r > 0.5 && d1 > 0 && d2 > 0) {
            const sx = curr.x - ((curr.x - prev.x) / d1) * r;
            const sy = curr.y - ((curr.y - prev.y) / d1) * r;
            const ex = curr.x + ((next.x - curr.x) / d2) * r;
            const ey = curr.y + ((next.y - curr.y) / d2) * r;
            ctx.lineTo(sx, sy);
            ctx.quadraticCurveTo(curr.x, curr.y, ex, ey);
          } else {
            ctx.lineTo(curr.x, curr.y);
          }
        }
        const last = pts[pts.length - 1]!;
        const beforeLast = pts[pts.length - 2]!;
        const tailLen = Math.hypot(last.x - beforeLast.x, last.y - beforeLast.y);
        const headSize = Math.max(10, s.strokeWidth * 3.5);
        const tipOffset = tailLen > headSize ? headSize * 0.75 : 0;
        const ang = Math.atan2(last.y - beforeLast.y, last.x - beforeLast.x);
        ctx.lineTo(last.x - tipOffset * Math.cos(ang), last.y - tipOffset * Math.sin(ang));
        ctx.stroke();

        // Start anchor node (filled if docked onto a shape, hollow ring if free)
        const nodeRadius = Math.max(3.5, s.strokeWidth * 1.15);
        ctx.beginPath();
        ctx.arc(pts[0]!.x, pts[0]!.y, nodeRadius, 0, Math.PI * 2);
        ctx.fillStyle = s.startAnchor ? s.strokeColor : '#FFFFFF';
        ctx.fill();
        ctx.stroke();

        // Solid filled flowchart arrowhead aligned with final orthogonal segment
        if (tailLen >= 2) {
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(
            last.x - headSize * Math.cos(ang - Math.PI / 6),
            last.y - headSize * Math.sin(ang - Math.PI / 6),
          );
          ctx.lineTo(
            last.x - headSize * Math.cos(ang + Math.PI / 6),
            last.y - headSize * Math.sin(ang + Math.PI / 6),
          );
          ctx.closePath();
          ctx.fillStyle = s.strokeColor;
          ctx.fill();
        }
      }
      break;
    }
    case 'sticky_note':
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = s.fillColor ?? '#FDE68A';
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 4);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      if (!hideText) drawText(ctx, s, STICKY_TEXT_COLOR);
      break;
    case 'text':
      if (!hideText) drawText(ctx, s, s.strokeColor);
      break;
  }
  ctx.restore();
}

/** Selection outline plus corner handles (drawn in world space; sizes scaled by zoom). */
export function renderSelection(
  ctx: CanvasRenderingContext2D,
  obj: WhiteboardObject,
  zoom: number,
  withHandles: boolean,
): void {
  const b = getBounds(obj);
  const pad = 4 / zoom;
  ctx.save();
  ctx.strokeStyle = '#2563EB';
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 3 / zoom]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  if (withHandles && obj.type !== 'stroke' && !isLinear(obj)) {
    const hs = HANDLE_SIZE / zoom;
    ctx.fillStyle = '#FFFFFF';
    for (const [cx, cy] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x, b.y + b.h],
      [b.x + b.w, b.y + b.h],
    ] as const) {
      ctx.beginPath();
      ctx.rect(cx - hs / 2, cy - hs / 2, hs, hs);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
