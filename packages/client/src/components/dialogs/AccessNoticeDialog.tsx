import React from 'react';
import { Eye, X } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const AccessNoticeDialog: React.FC = () => {
  const { accessNotice, dismissAccessNotice } = useWhiteboardStore();

  if (!accessNotice) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="access-notice-title"
    >
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl">
        <button
          type="button"
          onClick={dismissAccessNotice}
          aria-label="Close notification"
          className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300">
            <Eye className="h-5 w-5" />
          </div>
          <h2 id="access-notice-title" className="text-base font-bold">
            {accessNotice.title}
          </h2>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-slate-300">{accessNotice.message}</p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={dismissAccessNotice}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
