/**
 * @fileoverview Floating bottom dark property bar.
 * Provides contextual controls for active tool: color swatches,
 * stroke width, fill toggle, and typography settings.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Ban,
  Bold,
  BringToFront,
  Check,
  ChevronDown,
  Italic,
  Palette,
  SendToBack,
  Trash2,
  Type,
} from 'lucide-react';
import type { ShapeObject } from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { HexColorPicker } from './HexColorPicker.js';
import {
  colorChanges,
  defaultShapeAlign,
  isLinear,
  lighten,
  stickyFill,
} from '../canvas/shapes.js';

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

export type PropertyBarProps = Pick<
  ReturnType<typeof useWhiteboardStore.getState>,
  | 'activeTool'
  | 'toolProps'
  | 'setToolProps'
  | 'objects'
  | 'selectedIds'
  | 'activeTextEditor'
  | 'patchActiveTextEditor'
  | 'requestTextEdit'
  | 'requestCommitTextEdit'
  | 'updateObjects'
  | 'deleteObjects'
  | 'reorderObjects'
>;

export const PropertyBar: React.FC = () => {
  const store = useWhiteboardStore();
  return (
    <PropertyBarContent
      activeTool={store.activeTool}
      toolProps={store.toolProps}
      setToolProps={store.setToolProps}
      objects={store.objects}
      selectedIds={store.selectedIds}
      activeTextEditor={store.activeTextEditor}
      patchActiveTextEditor={store.patchActiveTextEditor}
      requestTextEdit={store.requestTextEdit}
      requestCommitTextEdit={store.requestCommitTextEdit}
      updateObjects={store.updateObjects}
      deleteObjects={store.deleteObjects}
      reorderObjects={store.reorderObjects}
    />
  );
};

export const PropertyBarContent: React.FC<PropertyBarProps> = ({
  activeTool,
  toolProps,
  setToolProps,
  objects,
  selectedIds,
  activeTextEditor,
  patchActiveTextEditor,
  requestTextEdit,
  requestCommitTextEdit,
  updateObjects,
  deleteObjects,
  reorderObjects,
}) => {
  const [fillMenuOpen, setFillMenuOpen] = useState(false);
  const fillPickerRef = useRef<HTMLDivElement | null>(null);

  const [strokeMenuOpen, setStrokeMenuOpen] = useState(false);
  const strokePickerRef = useRef<HTMLDivElement | null>(null);

  // Close the popovers whenever tool, selection, or text edit target changes.
  useEffect(() => {
    setFillMenuOpen(false);
    setStrokeMenuOpen(false);
  }, [activeTool, selectedIds, activeTextEditor?.objectId]);

  useClickOutside(fillMenuOpen, fillPickerRef, () => setFillMenuOpen(false));
  useClickOutside(strokeMenuOpen, strokePickerRef, () => setStrokeMenuOpen(false));

  const editingLiveText = activeTextEditor !== null;
  const selection = selectedIds.map((id) => objects[id]).filter((o) => o !== undefined);
  const editingSelection = !editingLiveText && activeTool === 'select' && selection.length > 0;
  const first = selection[0];
  const firstShape: ShapeObject | undefined = first?.type === 'shape' ? first : undefined;
  const liveObj =
    editingLiveText && activeTextEditor.objectId ? objects[activeTextEditor.objectId] : undefined;
  const liveShape: ShapeObject | undefined = liveObj?.type === 'shape' ? liveObj : undefined;

  const hasBoxText = selection.some((o) => o.type === 'shape' && !isLinear(o));
  const hasFillable = selection.some(
    (o) =>
      o.type === 'shape' &&
      (o.shapeType === 'rectangle' || o.shapeType === 'ellipse' || o.shapeType === 'sticky_note'),
  );
  const canClearSelectionFill = selection.some(
    (o) => o.type === 'shape' && (o.shapeType === 'rectangle' || o.shapeType === 'ellipse'),
  );

  const isShapeToolDefault = activeTool === 'rectangle' || activeTool === 'ellipse';
  const current = editingLiveText
    ? {
        color: activeTextEditor.strokeColor,
        width: liveShape?.strokeWidth ?? toolProps.width,
        fill: activeTextEditor.fillColor !== undefined,
        fillColor: activeTextEditor.fillColor ?? null,
        bold: activeTextEditor.bold,
        italic: activeTextEditor.italic,
        align: activeTextEditor.align,
        fontSize: activeTextEditor.fontSize,
      }
    : editingSelection
      ? {
          color:
            first?.type === 'stroke' ? first.color : (firstShape?.strokeColor ?? toolProps.color),
          width:
            first?.type === 'stroke' ? first.width : (firstShape?.strokeWidth ?? toolProps.width),
          fill: firstShape ? firstShape.fillColor !== undefined : toolProps.fill,
          fillColor: firstShape ? (firstShape.fillColor ?? null) : null,
          bold: firstShape?.bold ?? false,
          italic: firstShape?.italic ?? false,
          align: firstShape
            ? (firstShape.align ?? defaultShapeAlign(firstShape.shapeType))
            : 'left',
          fontSize: firstShape?.fontSize ?? toolProps.fontSize,
        }
      : {
          color: toolProps.color,
          width: toolProps.width,
          fill: toolProps.fill,
          fillColor: toolProps.fill
            ? (toolProps.fillColor ?? lighten(toolProps.color, 0.75))
            : null,
          bold: toolProps.bold,
          italic: toolProps.italic,
          align: isShapeToolDefault ? (toolProps.shapeAlign ?? 'center') : toolProps.align,
          fontSize: toolProps.fontSize,
        };

  const setColor = (color: string) => {
    if (editingLiveText) {
      const nextFill = activeTextEditor.shapeType === 'sticky_note' ? stickyFill(color) : undefined;
      patchActiveTextEditor({
        strokeColor: color,
        ...(nextFill !== undefined ? { fillColor: nextFill } : {}),
      });
      if (activeTextEditor.objectId) {
        updateObjects([activeTextEditor.objectId], (o) => colorChanges(o, color));
      } else {
        setToolProps({ color });
      }
      return;
    }
    if (editingSelection) {
      updateObjects(selectedIds, (o) => colorChanges(o, color));
    } else {
      setToolProps({ color });
    }
  };

  const setWidth = (width: number) => {
    const widthFor = (o: (typeof selection)[number]) =>
      o.type === 'shape' && (o.shapeType === 'text' || o.shapeType === 'sticky_note')
        ? {}
        : { strokeWidth: width };
    if (editingLiveText) {
      if (activeTextEditor.objectId) {
        updateObjects([activeTextEditor.objectId], widthFor);
      }
      setToolProps({ width });
      return;
    }
    if (editingSelection) {
      updateObjects(selectedIds, widthFor);
    } else {
      setToolProps({ width });
    }
  };

  const setFillColor = (fillColor: string | null) => {
    if (editingLiveText) {
      patchActiveTextEditor({ fillColor });
      if (activeTextEditor.objectId) {
        updateObjects([activeTextEditor.objectId], (o) =>
          o.type === 'shape' &&
          (o.shapeType === 'rectangle' ||
            o.shapeType === 'ellipse' ||
            o.shapeType === 'sticky_note')
            ? { fillColor }
            : {},
        );
      }
      return;
    }
    if (editingSelection) {
      updateObjects(selectedIds, (o) =>
        o.type === 'shape' &&
        (o.shapeType === 'rectangle' || o.shapeType === 'ellipse' || o.shapeType === 'sticky_note')
          ? { fillColor }
          : {},
      );
    } else if (fillColor === null) {
      setToolProps({ fill: false });
    } else {
      setToolProps({ fill: true, fillColor });
    }
  };

  const setText = (c: {
    bold?: boolean;
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    fontSize?: number;
  }) => {
    if (editingLiveText) {
      patchActiveTextEditor(c);
      if (activeTextEditor.objectId) {
        updateObjects([activeTextEditor.objectId], (o) =>
          o.type === 'shape' && !isLinear(o) ? c : {},
        );
      } else {
        setToolProps(c);
      }
      return;
    }
    if (editingSelection) {
      updateObjects(selectedIds, (o) => (o.type === 'shape' && !isLinear(o) ? c : {}));
    } else if (isShapeToolDefault && c.align !== undefined) {
      const { align, ...rest } = c;
      setToolProps({ ...rest, shapeAlign: align });
    } else {
      setToolProps(c);
    }
  };

  const nextAlign =
    current.align === 'left' ? 'center' : current.align === 'center' ? 'right' : 'left';

  // Hide property bar on select / eraser unless custom properties or active text edit apply
  const isDrawingOrShape = [
    'pen',
    'rectangle',
    'ellipse',
    'line',
    'arrow',
    'connector',
    'text',
    'sticky_note',
  ].includes(activeTool);

  if (!isDrawingOrShape && !editingSelection && !editingLiveText) {
    return null;
  }

  const isTextOrNote = editingLiveText
    ? true
    : editingSelection
      ? hasBoxText
      : activeTool === 'text' ||
        activeTool === 'sticky_note' ||
        activeTool === 'rectangle' ||
        activeTool === 'ellipse';

  const isShape = editingLiveText
    ? activeTextEditor.shapeType === 'rectangle' ||
      activeTextEditor.shapeType === 'ellipse' ||
      activeTextEditor.shapeType === 'sticky_note'
    : editingSelection
      ? hasFillable
      : isShapeToolDefault;

  const canClearFill = editingLiveText
    ? activeTextEditor.shapeType === 'rectangle' || activeTextEditor.shapeType === 'ellipse'
    : editingSelection
      ? canClearSelectionFill
      : isShapeToolDefault;

  // Line-only and text-only selections have no meaningful stroke width.
  const showWidth = editingLiveText
    ? activeTextEditor.shapeType === 'rectangle' || activeTextEditor.shapeType === 'ellipse'
    : editingSelection
      ? selection.some(
          (o) =>
            o.type === 'stroke' ||
            (o.type === 'shape' && o.shapeType !== 'text' && o.shapeType !== 'sticky_note'),
        )
      : activeTool !== 'text' && activeTool !== 'sticky_note';

  const canStartSingleTextEdit =
    !editingLiveText &&
    editingSelection &&
    selection.length === 1 &&
    first?.type === 'shape' &&
    !isLinear(first);

  const isCustomStrokeColor = !PALETTE_SWATCHES.some(
    (c) => c.toUpperCase() === current.color.toUpperCase(),
  );

  return (
    <div
      data-property-bar="true"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        // Keep focus inside the canvas inline text editor when clicking formatting/color buttons,
        // while allowing native <input type="color"> pickers to open normally.
        if (!(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
        }
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex max-w-[calc(100%-200px)] flex-wrap items-center justify-center gap-2 rounded-xl border border-slate-700/80 bg-slate-900/95 px-3 py-1.5 shadow-xl backdrop-blur-xl select-none"
    >
      {/* Stroke / Text Color Swatches & Hex GUI Palette */}
      <div className="flex items-center gap-1.5">
        {PALETTE_SWATCHES.map((color) => {
          const isSelected = current.color.toUpperCase() === color.toUpperCase();
          return (
            <button
              key={color}
              type="button"
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

        {/* Hex Choosable GUI Palette Button & Popover */}
        <div ref={strokePickerRef} className="relative flex items-center">
          <button
            type="button"
            onClick={() => setStrokeMenuOpen((v) => !v)}
            title={`More colors & custom hex (current: ${current.color})`}
            aria-label="Color Palette"
            className={`flex h-6 items-center gap-1 rounded-lg border px-1.5 py-0.5 text-xs font-medium transition ${
              strokeMenuOpen
                ? 'border-blue-500 bg-blue-600/30 text-blue-300'
                : isCustomStrokeColor
                  ? 'border-blue-500/80 bg-slate-800 text-slate-100 ring-1 ring-blue-500/50'
                  : 'border-slate-700/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <span
              className="h-3.5 w-3.5 rounded-full border border-slate-500/80 shrink-0 shadow-sm"
              style={{ backgroundColor: current.color }}
            />
            <Palette className="h-3 w-3" />
            <span className="font-mono text-[10px] tracking-tight uppercase">{current.color}</span>
          </button>

          {strokeMenuOpen && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-30">
              <HexColorPicker
                label="Stroke & Text Color"
                currentColor={current.color}
                onChangeColor={(hex) => setColor(hex)}
                onClose={() => setStrokeMenuOpen(false)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Stroke Width Buttons */}
      {showWidth && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <div className="flex items-center gap-1">
            {STROKE_WIDTHS.map((w) => {
              const isSelected = current.width === w.value;
              return (
                <button
                  key={w.value}
                  type="button"
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
        </>
      )}

      {/* Shape Fill Color Picker */}
      {isShape && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <div
            ref={fillPickerRef}
            className="relative flex items-center gap-1"
            data-fill-picker="true"
          >
            <button
              type="button"
              onClick={() => setFillMenuOpen((v) => !v)}
              title="Choose shape fill color"
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition ${
                current.fillColor
                  ? 'border-blue-500/40 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  : 'border-slate-700/80 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <span
                className="relative h-3.5 w-3.5 rounded border border-slate-500/80 shrink-0 overflow-hidden"
                style={{
                  backgroundColor: current.fillColor ?? 'transparent',
                }}
              >
                {!current.fillColor && (
                  <span className="absolute inset-0 block bg-[linear-gradient(135deg,transparent_44%,#ef4444_45%,#ef4444_55%,transparent_56%)]" />
                )}
              </span>
              <span>Fill</span>
              <ChevronDown className="h-3 w-3 text-slate-400" />
            </button>
            {current.fillColor && canClearFill && (
              <button
                type="button"
                onClick={() => {
                  setFillColor(null);
                  setFillMenuOpen(false);
                }}
                title="Remove fill (transparent)"
                className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-red-400 transition"
              >
                <Ban className="h-3 w-3" />
              </button>
            )}

            {fillMenuOpen && (
              <div
                data-property-bar="true"
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-30"
              >
                <HexColorPicker
                  label="Shape Fill Color"
                  currentColor={current.fillColor}
                  onChangeColor={(hex) => setFillColor(hex)}
                  onClearColor={() => setFillColor(null)}
                  canClear={canClearFill}
                  clearLabel="No Fill"
                  showTints={true}
                  onClose={() => setFillMenuOpen(false)}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Text Edit & Typography Controls */}
      {isTextOrNote && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <div className="flex items-center gap-1">
            {canStartSingleTextEdit && (
              <button
                type="button"
                onClick={() => requestTextEdit(first.id)}
                title="Edit text inside selected shape (Double-click or Enter)"
                className="mr-1 flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-600/20 px-2 py-1 text-xs font-medium text-blue-300 hover:bg-blue-600/35 transition"
              >
                <Type className="h-3 w-3" />
                <span>Edit Text</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setText({ bold: !current.bold })}
              title="Bold"
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                current.bold
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Bold className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setText({ italic: !current.italic })}
              title="Italic"
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                current.italic
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Italic className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setText({ align: nextAlign })}
              title={`Alignment: ${current.align}`}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white transition"
            >
              {current.align === 'left' && <AlignLeft className="h-3 w-3" />}
              {current.align === 'center' && <AlignCenter className="h-3 w-3" />}
              {current.align === 'right' && <AlignRight className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={() => setText({ fontSize: Math.max(8, current.fontSize - 2) })}
              title="Smaller text"
              className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition"
            >
              A-
            </button>
            <span className="min-w-[24px] text-center text-[11px] font-medium tabular-nums text-slate-400">
              {current.fontSize}
            </span>
            <button
              type="button"
              onClick={() => setText({ fontSize: Math.min(144, current.fontSize + 2) })}
              title="Larger text"
              className="flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition"
            >
              A+
            </button>
            {editingLiveText && (
              <button
                type="button"
                data-property-bar-commit="true"
                onClick={() => {
                  requestCommitTextEdit();
                  const surface = document.querySelector<HTMLElement>(
                    '[data-canvas-surface="true"]',
                  );
                  surface?.focus();
                }}
                title="Finish typing & exit (Enter, or Shift+Enter for new line)"
                className="ml-1 flex items-center gap-1 rounded-md bg-emerald-600/90 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500 transition"
              >
                <Check className="h-3 w-3" />
                <span>Done</span>
              </button>
            )}
          </div>
        </>
      )}

      {editingSelection && (
        <>
          <div className="h-4 w-[1px] bg-slate-800" />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => reorderObjects(selectedIds, 'front')}
              title="Bring to front"
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
            >
              <BringToFront className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => reorderObjects(selectedIds, 'back')}
              title="Send to back"
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
            >
              <SendToBack className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
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
