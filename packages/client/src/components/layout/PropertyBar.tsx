/**
 * @fileoverview Floating bottom dark property bar.
 * Provides contextual controls for active tool: color swatches,
 * stroke width, fill toggle, and typography settings.
 */

import React from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  BringToFront,
  Italic,
  Paintbrush,
  SendToBack,
  Trash2,
} from 'lucide-react';
import type { ShapeObject } from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { colorChanges, lighten } from '../canvas/shapes.js';

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
  const {
    activeTool,
    toolProps,
    setToolProps,
    objects,
    selectedIds,
    updateObjects,
    deleteObjects,
    reorderObjects,
  } = useWhiteboardStore();

  // With the select tool the bar edits the selection (synced OBJECT_UPDATE); otherwise it sets
  // the properties used by the next object drawn.
  const selection = selectedIds.map((id) => objects[id]).filter((o) => o !== undefined);
  const editingSelection = activeTool === 'select' && selection.length > 0;
  const first = selection[0];
  const firstShape: ShapeObject | undefined = first?.type === 'shape' ? first : undefined;
  const hasBoxText = selection.some(
    (o) => o.type === 'shape' && o.shapeType !== 'line' && o.shapeType !== 'arrow',
  );
  const hasFillable = selection.some(
    (o) => o.type === 'shape' && (o.shapeType === 'rectangle' || o.shapeType === 'ellipse'),
  );

  const current = editingSelection
    ? {
        color:
          first?.type === 'stroke' ? first.color : (firstShape?.strokeColor ?? toolProps.color),
        width:
          first?.type === 'stroke' ? first.width : (firstShape?.strokeWidth ?? toolProps.width),
        fill: firstShape ? firstShape.fillColor !== undefined : toolProps.fill,
        bold: firstShape?.bold ?? false,
        italic: firstShape?.italic ?? false,
        align: firstShape?.align ?? 'left',
        fontSize: firstShape?.fontSize ?? toolProps.fontSize,
      }
    : toolProps;

  const setColor = (color: string) =>
    editingSelection
      ? updateObjects(selectedIds, (o) => colorChanges(o, color))
      : setToolProps({ color });
  const setWidth = (width: number) =>
    editingSelection
      ? updateObjects(selectedIds, (o) =>
          o.type === 'shape' && (o.shapeType === 'text' || o.shapeType === 'sticky_note')
            ? {}
            : { strokeWidth: width },
        )
      : setToolProps({ width });
  const setFill = () =>
    editingSelection
      ? updateObjects(selectedIds, (o) =>
          o.type === 'shape' && (o.shapeType === 'rectangle' || o.shapeType === 'ellipse')
            ? { fillColor: o.fillColor ? null : lighten(o.strokeColor, 0.75) }
            : {},
        )
      : setToolProps({ fill: !toolProps.fill });
  const setText = (c: {
    bold?: boolean;
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    fontSize?: number;
  }) =>
    editingSelection
      ? updateObjects(selectedIds, (o) =>
          o.type === 'shape' && o.shapeType !== 'line' && o.shapeType !== 'arrow' ? c : {},
        )
      : setToolProps(c);
  const nextAlign =
    current.align === 'left' ? 'center' : current.align === 'center' ? 'right' : 'left';

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

  if (!isDrawingOrShape && !editingSelection) {
    return null;
  }

  const isTextOrNote = editingSelection
    ? hasBoxText
    : activeTool === 'text' || activeTool === 'sticky_note';
  const isShape = editingSelection
    ? hasFillable
    : activeTool === 'rectangle' || activeTool === 'ellipse';
  // Line-only and text-only selections have no meaningful stroke width.
  const showWidth = editingSelection
    ? selection.some(
        (o) =>
          o.type === 'stroke' ||
          (o.type === 'shape' && o.shapeType !== 'text' && o.shapeType !== 'sticky_note'),
      )
    : activeTool !== 'text' && activeTool !== 'sticky_note';

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex max-w-[calc(100%-260px)] items-center gap-2.5 rounded-xl border border-slate-700/80 bg-slate-900/95 px-3.5 py-1.5 shadow-xl backdrop-blur-xl select-none overflow-x-auto"
    >
      {/* Color Swatches */}
      <div className="flex items-center gap-1.5">
        {PALETTE_SWATCHES.map((color) => {
          const isSelected = current.color.toUpperCase() === color.toUpperCase();
          return (
            <button
              key={color}
              onClick={() => setColor(color)}
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
      {showWidth && (
        <div className="flex items-center gap-1">
          {STROKE_WIDTHS.map((w) => {
            const isSelected = current.width === w.value;
            return (
              <button
                key={w.value}
                onClick={() => setWidth(w.value)}
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
      )}

      {/* Shape Fill Toggle */}
      {isShape && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <button
            onClick={setFill}
            title="Toggle Shape Fill"
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
              current.fill
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
              onClick={() => setText({ bold: !current.bold })}
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                current.bold ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Bold className="h-3 w-3" />
            </button>
            <button
              onClick={() => setText({ italic: !current.italic })}
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                current.italic ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              <Italic className="h-3 w-3" />
            </button>
            <button
              onClick={() => setText({ align: nextAlign })}
              title={`Alignment: ${current.align}`}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 transition"
            >
              {current.align === 'left' && <AlignLeft className="h-3 w-3" />}
              {current.align === 'center' && <AlignCenter className="h-3 w-3" />}
              {current.align === 'right' && <AlignRight className="h-3 w-3" />}
            </button>
            <button
              onClick={() => setText({ fontSize: Math.max(8, current.fontSize - 2) })}
              title="Smaller text"
              className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold text-slate-400 hover:bg-slate-800 transition"
            >
              A-
            </button>
            <button
              onClick={() => setText({ fontSize: Math.min(144, current.fontSize + 2) })}
              title="Larger text"
              className="flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-slate-400 hover:bg-slate-800 transition"
            >
              A+
            </button>
          </div>
        </>
      )}

      {editingSelection && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <div className="flex items-center gap-1">
            <button
              onClick={() => reorderObjects(selectedIds, 'front')}
              title="Bring to front"
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 transition"
            >
              <BringToFront className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => reorderObjects(selectedIds, 'back')}
              title="Send to back"
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 transition"
            >
              <SendToBack className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => deleteObjects(selectedIds)}
              title="Delete (Del)"
              className="flex h-6 w-6 items-center justify-center rounded text-red-400 hover:bg-red-500/20 transition"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
};
