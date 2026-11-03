/**
 * @fileoverview Main Client Application component.
 * Assembles TopBar, LeftToolbar, Dot-Grid Canvas, PropertyBar, RightPanel,
 * and dialog modals in the exact visual design of the Figma/FigJam reference.
 */

import React, { useEffect } from 'react';
import { useWhiteboardStore } from './store/useWhiteboardStore.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { TopBar } from './components/layout/TopBar.js';
import { LeftToolbar } from './components/layout/LeftToolbar.js';
import { PropertyBar } from './components/layout/PropertyBar.js';
import { RightPanel } from './components/layout/RightPanel.js';
import { WhiteboardCanvas } from './components/canvas/WhiteboardCanvas.js';
import { ConnectDialog } from './components/dialogs/ConnectDialog.js';
import { ShareDialog } from './components/dialogs/ShareDialog.js';
import { ClearCanvasDialog } from './components/dialogs/ClearCanvasDialog.js';

export const App: React.FC = () => {
  useKeyboardShortcuts();

  const {
    isDarkTheme,
    handleIncomingEnvelope,
    setConnectionStatus,
    setConnectModalOpen,
    roomInfo,
  } = useWhiteboardStore();

  // Wire up Electron IPC message and status listeners
  useEffect(() => {
    if (window.electronAPI) {
      const unsubMessage = window.electronAPI.onMessage((envelope) => {
        handleIncomingEnvelope(envelope);
      });

      const unsubStatus = window.electronAPI.onStatus((event) => {
        setConnectionStatus(event.status, event.error);
      });

      return () => {
        unsubMessage();
        unsubStatus();
      };
    }
  }, [handleIncomingEnvelope, setConnectionStatus]);

  // Prompt connect modal on initial load if not connected
  useEffect(() => {
    if (!roomInfo) {
      setConnectModalOpen(true);
    }
  }, [roomInfo, setConnectModalOpen]);

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden ${isDarkTheme ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'}`}
    >
      {/* Top Header Bar */}
      <TopBar />

      {/* Main Workspace: Canvas + Floating Tools + Right Sidebar */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Left Floating Toolbar */}
        <LeftToolbar />

        {/* Center Canvas with Dot-Grid Viewport */}
        <div className="relative flex-1 h-full w-full overflow-hidden">
          <WhiteboardCanvas />
          <PropertyBar />
        </div>

        {/* Right Collapsible Chat & Participant Panel */}
        <RightPanel />
      </div>

      {/* Modals */}
      <ConnectDialog />
      <ShareDialog />
      <ClearCanvasDialog />
    </div>
  );
};

export default App;
