/**
 * @fileoverview Global keyboard shortcuts hook for whiteboard tool switching.
 * Matches standard FigJam / Figma keybindings:
 * - V / Escape: Select tool
 * - P: Pen / Freehand tool
 * - E: Eraser tool
 * - R: Rectangle tool
 * - O: Ellipse tool
 * - T: Text tool
 * - S: Sticky Note tool
 * - L: Arrow tool
 * - X / C: Orthogonal Connector tool
 * - N: Line tool
 * - K: Laser pointer
 *
 * Prevents hotkey interception when focus is inside text inputs, textareas,
 * or content-editable elements, or when modifier keys (Ctrl, Meta, Alt) are held.
 */

import { useEffect } from 'react';
import { type CanvasTool, useWhiteboardStore } from '../store/useWhiteboardStore.js';
import { isLinear } from '../components/canvas/shapes.js';

export const TOOL_SHORTCUTS: Record<string, CanvasTool> = {
  v: 'select',
  V: 'select',
  p: 'pen',
  P: 'pen',
  e: 'eraser',
  E: 'eraser',
  r: 'rectangle',
  R: 'rectangle',
  o: 'ellipse',
  O: 'ellipse',
  t: 'text',
  T: 'text',
  s: 'sticky_note',
  S: 'sticky_note',
  l: 'arrow',
  L: 'arrow',
  x: 'connector',
  X: 'connector',
  c: 'connector',
  C: 'connector',
  k: 'laser',
  K: 'laser',
  n: 'line',
  N: 'line',
};

/**
 * Checks whether an event target is an interactive editable form element.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  };
  const tagName = el.tagName?.toUpperCase();
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    Boolean(el.isContentEditable) ||
    (typeof el.closest === 'function' &&
      Boolean(el.closest('input, textarea, select, [contenteditable="true"]')))
  );
}

export function useKeyboardShortcuts(): void {
  const {
    setActiveTool,
    undoLastAction,
    redoLastAction,
    setSearchOpen,
    zoomIn,
    zoomOut,
    resetView,
    shortcutsModalOpen,
    setShortcutsModalOpen,
  } = useWhiteboardStore();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Do not intercept keystrokes when typing into form fields
      if (isEditableElement(e.target)) {
        return;
      }

      // 2. Open shortcuts modal on '?'
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsModalOpen(!shortcutsModalOpen);
        return;
      }

      // 3. Handle Ctrl/Cmd shortcuts
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'f') {
          e.preventDefault();
          setSearchOpen(true);
          return;
        }
        if (key === '=' || key === '+') {
          e.preventDefault();
          zoomIn();
          return;
        }
        if (key === '-' || key === '_') {
          e.preventDefault();
          zoomOut();
          return;
        }
        if (key === '0') {
          e.preventDefault();
          resetView();
          return;
        }
        if (key === 'z') {
          if (e.shiftKey) {
            redoLastAction();
          } else {
            undoLastAction();
          }
          e.preventDefault();
          return;
        }
        if (key === 'y') {
          redoLastAction();
          e.preventDefault();
          return;
        }
      }

      // 3. Escape reverts to Select tool
      if (e.key === 'Escape') {
        setActiveTool('select');
        return;
      }

      // 4. Ignore if system modifier keys (Ctrl, Meta/Cmd, Alt) are held
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      // Enter starts editing text inside a single selected shape / text box / sticky note
      if (
        e.key === 'Enter' &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest('button, a, [role="button"], [role="dialog"]')
        )
      ) {
        const state = useWhiteboardStore.getState();
        if (state.activeTextEditor === null && state.selectedIds.length === 1) {
          const selId = state.selectedIds[0];
          const obj = selId ? state.objects[selId] : undefined;
          if (obj && obj.type === 'shape' && !isLinear(obj)) {
            e.preventDefault();
            state.requestTextEdit(obj.id);
            return;
          }
        }
      }

      // 5. Map single-key shortcuts to whiteboard tools
      const tool = TOOL_SHORTCUTS[e.key];
      if (tool) {
        setActiveTool(tool);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    redoLastAction,
    resetView,
    setActiveTool,
    setSearchOpen,
    setShortcutsModalOpen,
    shortcutsModalOpen,
    undoLastAction,
    zoomIn,
    zoomOut,
  ]);
}
