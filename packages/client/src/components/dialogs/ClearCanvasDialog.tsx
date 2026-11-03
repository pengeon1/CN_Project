/**
 * @fileoverview Clear Canvas confirmation dialog.
 * Prompts the room host before permanently deleting all whiteboard objects.
 * Enforces role restriction (only HOST can execute).
 */

import React from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { Role } from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const ClearCanvasDialog: React.FC = () => {
  const { clearModalOpen, setClearModalOpen, clearCanvas, currentUser, roomInfo } =
    useWhiteboardStore();

  if (!clearModalOpen) return null;

  const isHost = currentUser?.role === Role.HOST;

  const handleConfirm = () => {
    if (isHost) {
      clearCanvas();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl text-slate-100">
        {/* Close Button */}
        <button
          onClick={() => setClearModalOpen(false)}
          className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/15 text-red-400 ring-1 ring-red-500/30">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-100">Clear Whiteboard?</h3>
            <p className="text-xs text-slate-400">
              {roomInfo ? `Room: ${roomInfo.code}` : 'Local Whiteboard'}
            </p>
          </div>
        </div>

        {/* Modal Body */}
        <div className="mt-4 text-xs text-slate-300 leading-relaxed">
          {isHost ? (
            <p>
              Are you sure you want to clear the entire canvas? This will permanently remove all
              strokes and drawings for{' '}
              <strong className="text-red-300">all connected collaborators</strong> in this session.
              This action cannot be undone.
            </p>
          ) : (
            <div className="rounded-lg bg-amber-500/10 p-3 text-amber-300 border border-amber-500/20">
              Only the room <strong>HOST</strong> can clear the canvas. You currently have the{' '}
              <span className="font-semibold">{currentUser?.role || 'VIEWER'}</span> role.
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            onClick={() => setClearModalOpen(false)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition"
          >
            Cancel
          </button>

          {isHost && (
            <button
              onClick={handleConfirm}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-red-600/30 hover:bg-red-500 transition active:scale-95"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear Canvas
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

