/**
 * @fileoverview Main canvas viewport with dot-grid background,
 * panning, zooming, and zoom level controls matching the design.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const WhiteboardCanvas: React.FC = () => {
  const { zoom, panX, panY, setZoom, adjustPan, resetView, isDarkTheme } = useWhiteboardStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const lastMousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Handle dot-grid canvas background rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Background color
      ctx.fillStyle = isDarkTheme ? '#0B0F19' : '#F8FAFC';
      ctx.fillRect(0, 0, width, height);

      // Dot grid settings
      const gridSize = 24 * zoom;
      const dotRadius = Math.max(1, 1.2 * zoom);
      ctx.fillStyle = isDarkTheme ? '#1E293B' : '#CBD5E1';

      const offsetX = (panX * zoom) % gridSize;
      const offsetY = (panY * zoom) % gridSize;

      for (let x = offsetX; x < width; x += gridSize) {
        for (let y = offsetY; y < height; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    };

    const animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [zoom, panX, panY, isDarkTheme]);

  // Window resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
      canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
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
      <canvas ref={canvasRef} className="h-full w-full" />

      {/* Floating Bottom-Right Zoom Percentage Control */}
      <div className="absolute bottom-6 right-6 z-20 flex items-center gap-1 rounded-2xl border border-slate-700/80 bg-slate-900/95 px-2 py-1 shadow-2xl backdrop-blur-xl select-none text-slate-200">
        <button
          onClick={() => setZoom((prev) => prev * 0.85)}
          title="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={() => resetView()}
          title="Reset zoom to 100%"
          className="px-2 text-xs font-mono font-semibold text-slate-200 hover:text-blue-400 transition"
        >
          {Math.round(zoom * 100)}%
        </button>

        <button
          onClick={() => setZoom((prev) => prev * 1.15)}
          title="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <div className="h-4 w-[1px] bg-slate-800 mx-0.5" />

        <button
          onClick={() => resetView()}
          title="Reset View"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
