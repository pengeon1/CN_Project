/**
 * @fileoverview Complete Keyboard Shortcuts Reference Modal.
 * Displays all available hotkeys categorized into Drawing Tools, Viewport Navigation,
 * Editing & History, and Text Editing with Figma-style key badges.
 */

import React, { useEffect, useState } from 'react';
import { Command, Keyboard, PenTool, Search, Type, X, ZoomIn } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

interface ShortcutItem {
  label: string;
  keys: string[];
  description?: string;
}

interface ShortcutSection {
  title: string;
  icon: React.ReactNode;
  items: ShortcutItem[];
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'Tools & Creation',
    icon: <PenTool className="h-4 w-4 text-blue-400" />,
    items: [
      { label: 'Select tool', keys: ['V', 'Esc'] },
      { label: 'Pen / Freehand', keys: ['P'] },
      { label: 'Eraser', keys: ['E'] },
      { label: 'Laser Pointer', keys: ['K'] },
      { label: 'Rectangle', keys: ['R'] },
      { label: 'Ellipse / Circle', keys: ['O'] },
      { label: 'Text Box', keys: ['T'] },
      { label: 'Sticky Note', keys: ['S'] },
      { label: 'Arrow', keys: ['L'] },
      { label: 'Orthogonal Connector', keys: ['X', 'C'] },
      { label: 'Straight Line', keys: ['N'] },
    ],
  },
  {
    title: 'Canvas Navigation',
    icon: <ZoomIn className="h-4 w-4 text-emerald-400" />,
    items: [
      { label: 'Pan canvas', keys: ['Space + Drag', 'Middle Click'] },
      { label: 'Zoom In', keys: ['Ctrl', '+'] },
      { label: 'Zoom Out', keys: ['Ctrl', '-'] },
      { label: 'Reset Zoom (100%)', keys: ['Ctrl', '0'] },
      { label: 'Smooth Zoom', keys: ['Ctrl', 'Scroll'] },
    ],
  },
  {
    title: 'Editing & Actions',
    icon: <Command className="h-4 w-4 text-purple-400" />,
    items: [
      { label: 'Undo', keys: ['Ctrl', 'Z'] },
      { label: 'Redo', keys: ['Ctrl', 'Y'] },
      { label: 'Redo (alternative)', keys: ['Ctrl + Shift', 'Z'] },
      { label: 'Delete selected', keys: ['Delete', 'Backspace'] },
      { label: 'Find on board (Search)', keys: ['Ctrl', 'F'] },
      { label: 'Deselect / Cancel', keys: ['Esc'] },
    ],
  },
  {
    title: 'Text & Sticky Notes',
    icon: <Type className="h-4 w-4 text-amber-400" />,
    items: [
      { label: 'New line in text / note', keys: ['Shift', 'Enter'] },
      { label: 'Finish editing & exit', keys: ['Enter'] },
      { label: 'Toggle shortcuts list', keys: ['?'] },
    ],
  },
];

export const KeyboardShortcutsDialog: React.FC = () => {
  const { shortcutsModalOpen, setShortcutsModalOpen } = useWhiteboardStore();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (shortcutsModalOpen) {
      setFilter('');
    }
  }, [shortcutsModalOpen]);

  useEffect(() => {
    if (!shortcutsModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShortcutsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcutsModalOpen, setShortcutsModalOpen]);

  if (!shortcutsModalOpen) {
    return null;
  }

  const query = filter.trim().toLowerCase();

  const filteredSections = SHORTCUT_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        item.keys.some((k) => k.toLowerCase().includes(query)),
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm select-none"
      onClick={() => setShortcutsModalOpen(false)}
    >
      <div
        className="relative flex w-full max-w-2xl max-h-[85vh] flex-col rounded-2xl border border-slate-700/80 bg-slate-900 p-6 text-slate-100 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
              <Keyboard className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Keyboard Shortcuts</h2>
              <p className="text-xs text-slate-400">
                Complete reference for quick whiteboard control
              </p>
            </div>
          </div>
          <button
            onClick={() => setShortcutsModalOpen(false)}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filter Input */}
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-950/80 px-3 py-2 text-xs">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter shortcuts (e.g. zoom, pen, delete)..."
            className="flex-1 bg-transparent text-xs text-slate-100 placeholder-slate-500 outline-none"
            autoFocus
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="text-slate-500 hover:text-slate-300 text-xs transition"
            >
              Clear
            </button>
          )}
        </div>

        {/* Shortcuts Content */}
        <div className="mt-4 flex-1 overflow-y-auto pr-1 space-y-6">
          {filteredSections.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500">
              No shortcuts found matching &quot;{filter}&quot;
            </div>
          ) : (
            filteredSections.map((sec) => (
              <div key={sec.title} className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                  {sec.icon}
                  <span>{sec.title}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {sec.items.map((item) => (
                    <div
                      key={item.label}
                      className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs"
                    >
                      <span className="text-slate-300">{item.label}</span>
                      <div className="flex items-center gap-1">
                        {item.keys.map((k) => (
                          <kbd
                            key={k}
                            className="rounded border border-slate-700/80 bg-slate-800/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-200 shadow-sm"
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3 text-[11px] text-slate-500">
          <span>
            Press <kbd className="rounded bg-slate-800 px-1 text-slate-300">?</kbd> anywhere to open
          </span>
          <span>LAN Real-Time Whiteboard</span>
        </div>
      </div>
    </div>
  );
};
