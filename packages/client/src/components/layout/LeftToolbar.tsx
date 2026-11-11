/**
 * @fileoverview Floating vertical dark toolbar matching the FigJam design reference.
 * Houses tool selectors: select, pen, eraser, shapes, text, sticky note, line/arrow, image.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Circle,
  Crosshair,
  Eraser,
  FolderOpen,
  History,
  Image as ImageIcon,
  Keyboard,
  Maximize2,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  Search,
  Square,
  StickyNote,
  Trash2,
  Type,
  Workflow,
} from 'lucide-react';
import { canMutateCanvas, isHost } from '@cn-whiteboard/common';
import { type CanvasTool, useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { insertImageFile } from '../canvas/imageInsert.js';

interface ToolItem {
  id: CanvasTool;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PRIMARY_TOOLS: ToolItem[] = [
  { id: 'select', label: 'Select (V)', icon: MousePointer2 },
  { id: 'pen', label: 'Draw Pen (P)', icon: Pencil },
  { id: 'eraser', label: 'Eraser (E)', icon: Eraser },
  { id: 'laser', label: 'Laser pointer (K)', icon: Crosshair },
  { id: 'rectangle', label: 'Rectangle (R)', icon: Square },
  { id: 'ellipse', label: 'Ellipse (O)', icon: Circle },
  { id: 'text', label: 'Text (T)', icon: Type },
  { id: 'sticky_note', label: 'Sticky Note (S)', icon: StickyNote },
  { id: 'arrow', label: 'Arrow (L)', icon: ArrowUpRight },
  { id: 'line', label: 'Line (N)', icon: Minus },
];

export const LeftToolbar: React.FC = () => {
  const {
    activeTool,
    setActiveTool,
    currentUser,
    roomInfo,
    setClearModalOpen,
    resetView,
    setSearchOpen,
    setLoadModalOpen,
    setVersionsOpen,
    setShortcutsModalOpen,
  } = useWhiteboardStore();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close more menu on click outside
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [moreMenuOpen]);
  const canEdit =
    !currentUser ||
    (canMutateCanvas(currentUser.role) && (!roomInfo?.locked || isHost(currentUser.role)));

  return (
    <aside
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-xl select-none"
    >
      {PRIMARY_TOOLS.map((tool) => {
        const Icon = tool.icon;
        // The laser is ephemeral presence, so even read-only viewers may point.
        const isDisabled = tool.id !== 'select' && tool.id !== 'laser' && !canEdit;
        const isActive = activeTool === tool.id && !isDisabled;

        return (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            disabled={isDisabled}
            title={isDisabled ? `${tool.label} (read-only)` : tool.label}
            className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition ${
              isActive
                ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                : isDisabled
                  ? 'cursor-not-allowed text-slate-700'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}

      <div className="my-0.5 h-[1px] w-5 bg-slate-800" />

      {/* Image insertion: file picker (drag-drop and paste also work on the canvas) */}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void insertImageFile(file);
        }}
      />
      <button
        onClick={() => fileInput.current?.click()}
        disabled={!canEdit}
        title={canEdit ? 'Insert Image (or drop / paste one)' : 'Insert Image (read-only)'}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
      >
        <ImageIcon className="h-4 w-4" />
      </button>

      {/* Connector Tool */}
      <button
        onClick={() => setActiveTool('arrow')}
        disabled={!canEdit}
        title={canEdit ? 'Connector / Arrow (X or L)' : 'Connector (read-only)'}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
          activeTool === 'arrow'
            ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
            : canEdit
              ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              : 'cursor-not-allowed text-slate-700'
        }`}
      >
        <Workflow className="h-4 w-4" />
      </button>

      {/* More / Overflow Menu */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMoreMenuOpen(!moreMenuOpen)}
          title="More Tools & Utilities"
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
            moreMenuOpen
              ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {moreMenuOpen && (
          <div className="absolute left-10 bottom-0 z-50 w-56 rounded-2xl border border-slate-700/80 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-xl text-slate-200 text-xs">
            <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-800 mb-1">
              Utilities &amp; Tools
            </div>

            <button
              onClick={() => {
                resetView();
                setMoreMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-slate-800 transition text-slate-300 hover:text-white"
            >
              <Maximize2 className="h-4 w-4 text-blue-400" />
              <span>Reset View (100%)</span>
            </button>

            <button
              onClick={() => {
                setSearchOpen(true);
                setMoreMenuOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-slate-800 transition text-slate-300 hover:text-white"
            >
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-cyan-400" />
                <span>Find on Board</span>
              </div>
              <kbd className="rounded border border-slate-700 px-1 text-[10px] text-slate-500 font-mono">
                Ctrl+F
              </kbd>
            </button>

            <button
              onClick={() => {
                setLoadModalOpen(true);
                setMoreMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-slate-800 transition text-slate-300 hover:text-white"
            >
              <FolderOpen className="h-4 w-4 text-amber-400" />
              <span>Load Previous Save</span>
            </button>

            <button
              onClick={() => {
                setVersionsOpen(true);
                setMoreMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-slate-800 transition text-slate-300 hover:text-white"
            >
              <History className="h-4 w-4 text-purple-400" />
              <span>Version History</span>
            </button>

            <div className="my-1 h-[1px] bg-slate-800" />

            <button
              onClick={() => {
                setShortcutsModalOpen(true);
                setMoreMenuOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-slate-800 transition text-slate-300 hover:text-white"
            >
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-cyan-400" />
                <span>All Shortcuts</span>
              </div>
              <kbd className="rounded border border-slate-700 bg-slate-800 px-1 text-[10px] text-slate-400 font-mono">
                ?
              </kbd>
            </button>
          </div>
        )}
      </div>

      <div className="my-0.5 h-[1px] w-5 bg-slate-800" />

      {/* Clear Canvas Action */}
      <button
        onClick={() => setClearModalOpen(true)}
        title={isHost(currentUser?.role) ? 'Clear Canvas (Host)' : 'Clear Canvas (Host only)'}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
          isHost(currentUser?.role)
            ? 'text-red-400 hover:bg-red-500/20 hover:text-red-300'
            : 'text-slate-600 hover:bg-slate-800/50 hover:text-slate-400 cursor-not-allowed'
        }`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </aside>
  );
};
