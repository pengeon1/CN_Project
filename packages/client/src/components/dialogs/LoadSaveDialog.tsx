/**
 * @fileoverview Dialog that allows the user to choose which save or version to load:
 * - Specific saved versions and snapshots from version history
 * - Latest server auto-saved room state
 * - Import a previously exported board .json file
 */

import React, { useRef, useState } from 'react';
import {
  Clock,
  FileCode,
  FolderOpen,
  HardDrive,
  History,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import type { RoomSnapshot } from '@cn-whiteboard/common';

export const LoadSaveDialog: React.FC = () => {
  const {
    loadModalOpen,
    setLoadModalOpen,
    versions,
    requestVersions,
    restoreVersion,
    requestLoadState,
    roomInfo,
  } = useWhiteboardStore();

  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!loadModalOpen) return null;

  const handleRestoreVersion = (versionId: string, versionName: string) => {
    if (
      window.confirm(
        `Load and restore "${versionName}"? Current unsaved changes on the board will be replaced.`,
      )
    ) {
      restoreVersion(versionId);
      setLoadModalOpen(false);
    }
  };

  const handleLoadLatestServerSave = () => {
    if (
      window.confirm(
        'Load the latest auto-saved room state from the server? Current unsaved changes will be replaced.',
      )
    ) {
      void requestLoadState();
      setLoadModalOpen(false);
    }
  };

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = String(event.target?.result ?? '');
        const data = JSON.parse(text) as {
          snapshot?: RoomSnapshot;
          objects?: Record<string, unknown>;
        };

        const targetObjects = data.snapshot?.objects ?? data.objects;
        if (!targetObjects || typeof targetObjects !== 'object') {
          throw new Error('Invalid whiteboard JSON format: missing objects mapping.');
        }

        if (
          window.confirm(
            `Import and load board from "${file.name}" (${Object.keys(targetObjects).length} objects)? This will replace current objects.`,
          )
        ) {
          useWhiteboardStore.setState({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            objects: targetObjects as any,
            selectedIds: [],
            persistenceStatus: `Loaded board from ${file.name}`,
          });
          setLoadModalOpen(false);
        }
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Failed to parse JSON file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={() => setLoadModalOpen(false)}
    >
      <div
        className="relative flex max-h-[88vh] w-full max-w-xl flex-col rounded-2xl border border-slate-700/80 bg-slate-900/95 p-6 text-slate-100 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/20 text-blue-400">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Choose a Save to Load</h2>
              <p className="text-xs text-slate-400">
                Select a previous version or snapshot from room {roomInfo?.code ?? ''}
              </p>
            </div>
          </div>
          <button
            onClick={() => setLoadModalOpen(false)}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Import error banner */}
        {importError && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {importError}
          </div>
        )}

        {/* Content list */}
        <div className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1">
          {/* Quick options: Server autosave & JSON file */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={handleLoadLatestServerSave}
              className="flex items-start gap-3 rounded-xl border border-slate-700/80 bg-slate-950/60 p-3 text-left hover:border-blue-500/60 hover:bg-slate-950 transition"
            >
              <HardDrive className="h-4 w-4 mt-0.5 text-blue-400 shrink-0" />
              <div>
                <div className="text-xs font-semibold text-slate-200">Latest Server Autosave</div>
                <div className="text-[11px] text-slate-400">Restore room from server disk</div>
              </div>
            </button>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleFileImport}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-700/80 bg-slate-950/60 p-3 text-left hover:border-emerald-500/60 hover:bg-slate-950 transition"
              >
                <FileCode className="h-4 w-4 mt-0.5 text-emerald-400 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-slate-200">Load from .json File</div>
                  <div className="text-[11px] text-slate-400">Import file from computer</div>
                </div>
              </button>
            </div>
          </div>

          {/* Previous Saves List */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <History className="h-3.5 w-3.5 text-slate-400" />
                Saved Versions &amp; Snapshots ({versions.length})
              </span>
              <button
                onClick={requestVersions}
                className="text-[11px] text-blue-400 hover:text-blue-300 underline"
              >
                Refresh list
              </button>
            </div>

            {versions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
                <Clock className="h-5 w-5 mx-auto mb-1.5 opacity-40" />
                No saved versions found for this session yet.
                <div className="mt-1 text-[11px] text-slate-600">
                  Click the &quot;Save&quot; or &quot;History&quot; buttons in the top bar to create
                  saved checkpoints.
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3 hover:border-slate-700 transition"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-slate-200">
                          {v.name}
                        </span>
                        {v.auto ? (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                            Auto
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">
                            <Sparkles className="h-2.5 w-2.5" />
                            Saved
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {new Date(v.ts).toLocaleString()} · {v.objectCount} object
                        {v.objectCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRestoreVersion(v.id, v.name)}
                      className="flex items-center gap-1.5 rounded-lg bg-blue-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 transition shadow-sm"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Load this Save
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-end border-t border-slate-800/80 pt-3">
          <button
            onClick={() => setLoadModalOpen(false)}
            className="rounded-lg border border-slate-700 px-4 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
