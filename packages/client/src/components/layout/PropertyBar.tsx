/**
 * @fileoverview Floating bottom dark property bar.
 * Provides contextual controls for active tool: color swatches,
 * stroke width, fill toggle, and typography settings.
 */

import React from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Paintbrush } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

const PALETTE_SWATCHES = [
  '#000000', // Black
  '#FFFFFF', // White
  '#EF4444', // Red
  '#F97316', // Orange
  '#10B981', // Emerald
  '#18A0FB', // Blue
  '#8B5CF6', // Purple
  '#EC4899', // Pink
];

const STROKE_WIDTHS = [
  { label: 'S', value: 2 },
  { label: 'M', value: 4 },
  { label: 'L', value: 8 },
  { label: 'XL', value: 16 },
];

export const PropertyBar: React.FC = () => {
  const { activeTool, toolProps, setToolProps } = useWhiteboardStore();

  // Hide property bar on select / eraser unless custom properties apply
  const isDrawingOrShape = [
    'pen',
    'rectangle',
    'ellipse',
    'line',
    'arrow',
    'text',
    'sticky_note',
  ].includes(activeTool);

  if (!isDrawingOrShape) {
    return null;
  }

  const isTextOrNote = activeTool === 'text' || activeTool === 'sticky_note';
  const isShape = activeTool === 'rectangle' || activeTool === 'ellipse';

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 rounded-2xl border border-slate-700/80 bg-slate-900/95 px-4 py-2 shadow-2xl backdrop-blur-xl select-none">
      {/* Color Swatches */}
      <div className="flex items-center gap-1.5">
        {PALETTE_SWATCHES.map((color) => {
          const isSelected = toolProps.color === color;
          return (
            <button
              key={color}
              onClick={() => setToolProps({ color })}
              style={{ backgroundColor: color }}
              title={`Color: ${color}`}
              className={`h-5 w-5 rounded-full border border-slate-700 transition transform ${
                isSelected
                  ? 'scale-125 ring-2 ring-blue-500 ring-offset-2 ring-offset-slate-900'
                  : 'hover:scale-110'
              }`}
            />
          );
        })}
      </div>

      <div className="h-4 w-[1px] bg-slate-800" />

      {/* Stroke Width Buttons */}
      <div className="flex items-center gap-1">
        {STROKE_WIDTHS.map((w) => {
          const isSelected = toolProps.width === w.value;
          return (
            <button
              key={w.value}
              onClick={() => setToolProps({ width: w.value })}
              className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold transition ${
                isSelected
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {w.label}
            </button>
          );
        })}
      </div>

      {/* Shape Fill Toggle */}
      {isShape && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <button
            onClick={() => setToolProps({ fill: !toolProps.fill })}
            title="Toggle Shape Fill"
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
              toolProps.fill
                ? 'bg-blue-600/30 text-blue-400 border border-blue-500/40'
                : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            <Paintbrush className="h-3.5 w-3.5" />
            <span>Fill</span>
          </button>
        </>
      )}

      {/* Typography Controls */}
      {isTextOrNote && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <div className="flex items-center gap-1">
            <button
              onClick={() => setToolProps({ bold: !toolProps.bold })}
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                toolProps.bold ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Bold className="h-3 w-3" />
            </button>
            <button
              onClick={() => setToolProps({ italic: !toolProps.italic })}
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                toolProps.italic ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Italic className="h-3 w-3" />
            </button>
            <button
              onClick={() =>
                setToolProps({
                  align:
                    toolProps.align === 'left'
                      ? 'center'
                      : toolProps.align === 'center'
                        ? 'right'
                        : 'left',
                })
              }
              title={`Alignment: ${toolProps.align}`}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 transition"
            >
              {toolProps.align === 'left' && <AlignLeft className="h-3 w-3" />}
              {toolProps.align === 'center' && <AlignCenter className="h-3 w-3" />}
              {toolProps.align === 'right' && <AlignRight className="h-3 w-3" />}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
