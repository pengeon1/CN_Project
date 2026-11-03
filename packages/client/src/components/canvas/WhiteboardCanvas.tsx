/**
 * @fileoverview Main canvas viewport with razor-sharp dot-grid background,
 * adaptive zoom grid spacing (preventing dot overlap at any scale),
 * high-DPI (Retina) scaling, panning, zooming, and non-overlapping controls.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const WhiteboardCanvas: React.FC = () => {
  const { zoom, panX, panY, setZoom, adjustPan, resetView, isDarkTheme } = useWhiteboardStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const lastMousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  /**
   * Razor-sharp high-DPI canvas rendering routine.
   * Uses adaptive grid spacing so dots NEVER overlap regardless of zoom level (10% to 500%).
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

    // Background fill
    ctx.fillStyle = isDarkTheme ? '#0B0F19' : '#F8FAFC';
    ctx.fillRect(0, 0, width, height);

    // Adaptive grid spacing (Figma/FigJam style):
    // Keeps grid spacing between 20px and 60px on screen at all times.
    // Prevents dots from ever crowding or overlapping when zooming out.
    const baseGrid = 24;
    let gridSize = baseGrid * zoom;
    while (gridSize < 20) {
      gridSize *= 2;
    }
    while (gridSize > 64) {
      gridSize /= 2;
    }

    // Razor-sharp constant dot radius
    const dotRadius = 1.25;

    // Subtle, non-intrusive dot colors
    ctx.fillStyle = isDarkTheme ? 'rgba(148, 163, 184, 0.3)' : 'rgba(100, 116, 139, 0.35)';

    // Wrap offset cleanly across negative and positive pan values
    const startX = (((panX * zoom) % gridSize) + gridSize) % gridSize;
    const startY = (((panY * zoom) % gridSize) + gridSize) % gridSize;

    // Draw dots snapping to integer pixel centers to eliminate blur and ensure zero overlap
    for (let x = startX; x < width; x += gridSize) {
      const px = Math.round(x);
      for (let y = startY; y < height; y += gridSize) {
        const py = Math.round(y);
        ctx.beginPath();
        ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [zoom, panX, panY, isDarkTheme]);

  // Re-render when viewport or theme properties change
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

  // Pan via Space + Drag or Middle Mouse
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.spaceKey || (e.buttons === 1 && e.altKey)) {
      setIsPanning(true);
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      const dx = (e.clientX - lastMousePos.current.x) / zoom;
      const dy = (e.clientY - lastMousePos.current.y) / zoom;
      adjustPan(dx, dy);
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  // Zoom via Ctrl/Cmd + Wheel
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      setZoom((prev) => prev * zoomFactor);
    } else {
      // Regular two-finger scroll panning
      adjustPan(-e.deltaX / zoom, -e.deltaY / zoom);
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      className={`relative h-full w-full overflow-hidden ${
        isPanning ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
      }`}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full pointer-events-none"
        style={{ imageRendering: 'auto' }}
      />

      {/* Floating Bottom-Right Zoom Percentage Control (positioned so it never overlaps PropertyBar) */}
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
