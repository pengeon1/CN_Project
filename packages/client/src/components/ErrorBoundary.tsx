/**
 * @fileoverview React Error Boundary.
 * Catches unhandled runtime render exceptions and prevents blank white screen crashes.
 * Displays a recovery dialog with error diagnostic details and a reload action.
 */

import React, { type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[Whiteboard ErrorBoundary] Uncaught render exception:', error, errorInfo);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 p-6 text-slate-100 select-none">
          <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-400 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/20 border border-red-500/30">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-white">Whiteboard Render Error</h1>
                <p className="text-xs text-slate-400">
                  An unexpected exception was safely intercepted.
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs font-mono text-red-300 break-words max-h-36 overflow-y-auto">
              {this.state.error?.message || 'Unknown runtime error occurred.'}
            </div>

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={this.handleReload}
                className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 transition shadow-lg shadow-blue-500/20"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reload Whiteboard
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
