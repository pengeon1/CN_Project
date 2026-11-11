/**
 * @fileoverview Host-only version history: save a named snapshot of the board and restore any
 * earlier snapshot. Automatic snapshots are listed alongside named ones.
 */

import React, { useState } from 'react';
import { History, RotateCcw, X } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const VersionHistoryDialog: React.FC = () => {
  const { versionsOpen, setVersionsOpen, versions, saveVersion, restoreVersion, requestVersions } =
    useWhiteboardStore();
  const [name, setName] = useState('');

  if (!versionsOpen) return null;

  const save = () => {
    if (!name.trim()) return;
    saveVersion(name);
    setName('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-2xl">
        <button
          onClick={() => setVersionsOpen(false)}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3">
          <History className="h-5 w-5 text-blue-400" />
          <h3 className="text-base font-bold">Version history</h3>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Restoring replaces the board for everyone. The current board is saved first, so a restore
          can be reverted.
        </p>

        <div className="mt-4 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            maxLength={60}
            placeholder="Name this version (e.g. Before workshop)"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
          />
          <button
            onClick={save}
            disabled={!name.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Save version
          </button>
        </div>

        <ul className="mt-4 flex-1 space-y-1.5 overflow-y-auto">
          {versions.length === 0 && (
            <li className="py-6 text-center text-xs text-slate-500">No versions saved yet.</li>
          )}
          {versions.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">{v.name}</div>
                <div className="text-[11px] text-slate-400">
                  {new Date(v.ts).toLocaleString()} · {v.objectCount} object
                  {v.objectCount === 1 ? '' : 's'}
                  {v.auto ? ' · automatic' : ''}
                </div>
              </div>
              <button
                onClick={() => {
                  if (
                    window.confirm(`Restore "${v.name}"? This replaces the board for everyone.`)
                  ) {
                    restoreVersion(v.id);
                  }
                }}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-300 hover:bg-slate-800"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </button>
            </li>
          ))}
        </ul>
        <button
          onClick={requestVersions}
          className="mt-3 self-start text-[11px] text-slate-400 underline hover:text-slate-200"
        >
          Refresh list
        </button>
      </div>
    </div>
  );
};
