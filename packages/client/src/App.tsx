/**
 * @fileoverview Main Client Application component.
 * Assembles TopBar, LeftToolbar, Dot-Grid Canvas, PropertyBar, RightPanel,
 * and dialog modals in the exact visual design of the Figma/FigJam reference.
 */

import React, { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
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
import { AccessNoticeDialog } from './components/dialogs/AccessNoticeDialog.js';
import { VersionHistoryDialog } from './components/dialogs/VersionHistoryDialog.js';
import { ProfileSettingsDialog } from './components/dialogs/ProfileSettingsDialog.js';
import { SearchDialog } from './components/dialogs/SearchDialog.js';
import { LoadSaveDialog } from './components/dialogs/LoadSaveDialog.js';
import { KeyboardShortcutsDialog } from './components/dialogs/KeyboardShortcutsDialog.js';

export const App: React.FC = () => {
  useKeyboardShortcuts();

  const {
    isDarkTheme,
    connectionStatus,
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

      {/* Reconnecting Status Banner */}
      {connectionStatus === 'reconnecting' && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-amber-500/95 px-4 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur animate-pulse pointer-events-none">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          <span>Connection lost. Reconnecting to whiteboard...</span>
        </div>
      )}

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
      <AccessNoticeDialog />
      <ProfileSettingsDialog />
      <VersionHistoryDialog />
      <SearchDialog />
      <LoadSaveDialog />
      <KeyboardShortcutsDialog />
    </div>
  );
};

export default App;
