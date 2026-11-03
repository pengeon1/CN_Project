import React from 'react';
import { APP_NAME, APP_VERSION } from '@cn-whiteboard/common';
import { CheckCircle2, Monitor, Network, ShieldCheck, Sparkles } from 'lucide-react';

export const App: React.FC = () => {
  return (
    <div className="flex h-screen w-screen flex-col bg-slate-900 text-slate-100 font-sans">
      {/* Header bar matching the target UI theme */}
      <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white font-bold shadow-md shadow-blue-500/20">
            W
          </div>
          <span className="font-semibold tracking-tight text-white">{APP_NAME}</span>
          <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
            v{APP_VERSION}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500"></span>
          Phase 0: Foundation Ready
        </div>
      </header>

      {/* Main content body */}
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950/50 p-8 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-3 text-blue-400">
            <Sparkles className="h-6 w-6" />
            <h1 className="text-xl font-bold tracking-tight text-white">
              System Architecture Initialized
            </h1>
          </div>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            The monorepo foundation, TypeScript strict typing, raw TCP server layer, and Electron
            desktop shell have been successfully configured and verified.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-slate-900/60 p-4">
              <Network className="h-5 w-5 text-blue-400 mt-0.5 flex-shrink-0" />
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Raw TCP Socket Server</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Node.js <code className="text-blue-300">net</code> module with LAN IP
                  autodetection and zero external network frameworks.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-slate-900/60 p-4">
              <Monitor className="h-5 w-5 text-indigo-400 mt-0.5 flex-shrink-0" />
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Electron Main Process</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Isolated rendering with contextBridge; socket communication dedicated to the main
                  process.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-slate-900/60 p-4">
              <ShieldCheck className="h-5 w-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <div>
                <h2 className="text-sm font-semibold text-slate-200">TypeScript Strict Mode</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Universal type-safety with shared definitions in{' '}
                  <code className="text-emerald-300">@cn-whiteboard/common</code>.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-slate-900/60 p-4">
              <CheckCircle2 className="h-5 w-5 text-purple-400 mt-0.5 flex-shrink-0" />
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Multi-OS CI Matrix</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Automated test & build pipelines running against Linux, macOS, and Windows.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-8 rounded-lg bg-slate-900/90 p-4 border border-slate-800 text-xs font-mono text-slate-300">
            <div className="text-slate-500 mb-1">// Next Phase:</div>
            <div className="text-blue-400 font-semibold">PHASE 1 - Protocol and Framing</div>
            <div className="text-slate-400 mt-1">
              Length-prefixed binary framing, Zod schema validation, and{' '}
              <code className="text-slate-300">docs/protocol.md</code>.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
