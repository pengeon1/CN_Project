/**
 * @fileoverview Floating vertical dark toolbar matching the FigJam design reference.
 * Houses tool selectors: select, pen, eraser, shapes, text, sticky note, line/arrow, image.
 */

import React from 'react';
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Image as ImageIcon,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  Square,
  StickyNote,
  Type,
  Workflow,
} from 'lucide-react';
import { type CanvasTool, useWhiteboardStore } from '../../store/useWhiteboardStore.js';

interface ToolItem {
  id: CanvasTool;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PRIMARY_TOOLS: ToolItem[] = [
  { id: 'select', label: 'Select (V)', icon: MousePointer2 },
  { id: 'pen', label: 'Draw Pen (P)', icon: Pencil },
  { id: 'eraser', label: 'Eraser (E)', icon: Eraser },
  { id: 'rectangle', label: 'Rectangle (R)', icon: Square },
  { id: 'ellipse', label: 'Ellipse (O)', icon: Circle },
  { id: 'text', label: 'Text (T)', icon: Type },
  { id: 'sticky_note', label: 'Sticky Note (S)', icon: StickyNote },
  { id: 'arrow', label: 'Arrow / Line (L)', icon: ArrowUpRight },
];

export const LeftToolbar: React.FC = () => {
  const { activeTool, setActiveTool } = useWhiteboardStore();

  return (
    <aside className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-xl select-none">
      {PRIMARY_TOOLS.map((tool) => {
        const Icon = tool.icon;
        const isActive = activeTool === tool.id;

        return (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            title={tool.label}
            className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition ${
              isActive
                ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}

      <div className="my-0.5 h-[1px] w-5 bg-slate-800" />

      {/* Image Insertion Placeholder */}
      <button
        title="Insert Image"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
      >
        <ImageIcon className="h-4 w-4" />
      </button>

      {/* Connector Tool */}
      <button
        title="Connector"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
      >
        <Workflow className="h-4 w-4" />
      </button>

      {/* More / Overflow Menu */}
      <button
        title="More Tools"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </aside>
  );
};
