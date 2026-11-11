/**
 * @fileoverview Top navigation bar matching the design reference.
 * Houses session title, last-saved status, participant avatar stack,
 * search button, chat toggle with unread counter, and prominent Share button.
 */

import React, { useState } from 'react';
import {
  ArrowLeft,
  Download,
  History,
  Lock,
  LockOpen,
  LogIn,
  MessageSquare,
  Moon,
  Presentation,
  Search,
  Share2,
  Sun,
  Upload,
  Save,
} from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';
import { exportBoardPdf, exportBoardPng } from '../../export/boardExport.js';

export const TopBar: React.FC = () => {
  const [exportOpen, setExportOpen] = useState(false);
  const {
    roomInfo,
    persistenceStatus,
    currentUser,
    participants,
    rightPanelOpen,
    rightPanelTab,
    unreadChatCount,
    isDarkTheme,
    setRightPanelOpen,
    setShareModalOpen,
    setConnectModalOpen,
    disconnectFromServer,
    toggleTheme,
    requestSaveState,
    requestLoadState,
    exportBoard,
    sendPermissionChange,
    presentation,
    setPresenting,
    setVersionsOpen,
  } = useWhiteboardStore();

  const getInitials = (name: string): string => {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <header className="flex h-14 w-full items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 z-20">
      {/* Left: Back / Leave button & Session title */}
      <div className="flex items-center gap-3">
        {roomInfo ? (
          <button
            onClick={() => disconnectFromServer()}
            title="Leave room"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={() => setConnectModalOpen(true)}
            title="Connect / Host Room"
            className="flex items-center gap-1.5 rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-400 transition"
          >
            <LogIn className="h-3.5 w-3.5" />
            Connect
          </button>
        )}

        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-800 dark:text-slate-100 tracking-tight">
              {roomInfo ? roomInfo.name : 'LAN Collaborative Whiteboard'}
            </span>
            {roomInfo && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {roomInfo.code}
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {roomInfo ? (persistenceStatus ?? 'Changes autosaved') : 'No active session'}
          </span>
        </div>
      </div>

      {/* Right controls: Avatars, Search, Chat, Share, Theme */}
      <div className="flex items-center gap-2.5">
        {roomInfo && (
          <>
            {roomInfo.isHost && (
              <>
                <button
                  onClick={() => sendPermissionChange({ lockRoom: !roomInfo.locked })}
                  title={
                    roomInfo.locked ? 'Unlock room for participants' : 'Lock room against edits'
                  }
                  aria-label={roomInfo.locked ? 'Unlock room' : 'Lock room'}
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition"
                >
                  {roomInfo.locked ? (
                    <Lock className="h-4 w-4" />
                  ) : (
                    <LockOpen className="h-4 w-4" />
                  )}
                  {roomInfo.locked ? 'Unlock' : 'Lock'}
                </button>
                <button
                  onClick={() => setPresenting(!presentation.active)}
                  title={
                    presentation.active ? 'Stop presenting' : 'Present: everyone follows your view'
                  }
                  className={`flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium transition ${
                    presentation.active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  <Presentation className="h-4 w-4" />
                  {presentation.active ? 'Stop' : 'Present'}
                </button>
                <button
                  onClick={() => setVersionsOpen(true)}
                  title="Version history"
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition"
                >
                  <History className="h-4 w-4" />
                  History
                </button>
                <button
                  onClick={() => void requestSaveState()}
                  title="Save room to the server"
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition"
                >
                  <Save className="h-4 w-4" />
                  Save
                </button>
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        'Load the last saved board? Current unsaved changes will be replaced.',
                      )
                    ) {
                      void requestLoadState();
                    }
                  }}
                  title="Load the last saved room state"
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition"
                >
                  <Upload className="h-4 w-4" />
                  Load
                </button>
              </>
            )}
            <div className="relative">
              <button
                onClick={() => setExportOpen((o) => !o)}
                title="Export the board"
                className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition"
              >
                <Download className="h-4 w-4" />
                Export
              </button>
              {exportOpen && (
                <div className="absolute right-0 top-9 z-50 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                  {[
                    ['PNG image', () => void exportBoardPng()],
                    ['PDF document', () => void exportBoardPdf()],
                    ['Board data (.json)', () => void exportBoard()],
                  ].map(([label, run]) => (
                    <button
                      key={label as string}
                      onClick={() => {
                        setExportOpen(false);
                        (run as () => void)();
                      }}
                      className="block w-full rounded-md px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      {label as string}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Participant Avatar Stack */}
        <div className="flex items-center -space-x-1.5 overflow-hidden py-1">
          {participants.map((p) => {
            const isMe = currentUser?.id === p.id;
            return (
              <div
                key={p.id}
                title={`${p.username} (${p.role})${isMe ? ' - You' : ''}`}
                style={{ backgroundColor: p.color }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white ring-2 ring-white dark:ring-slate-900 shadow-sm cursor-default select-none"
              >
                {getInitials(p.username)}
              </div>
            );
          })}
        </div>

        {/* Find on board button */}
        <button
          title="Search"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition"
        >
          <Search className="h-4 w-4" />
        </button>

        {/* Theme Toggle */}
        <button
          onClick={() => toggleTheme()}
          title="Toggle light / dark theme"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition"
        >
          {isDarkTheme ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* Chat / Sidebar Toggle with unread badge */}
        <button
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          title="Toggle Chat & Collaborators"
          className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition ${
            rightPanelOpen
              ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/80 dark:text-blue-400'
              : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
          }`}
        >
          <MessageSquare className="h-4 w-4" />
          {unreadChatCount > 0 && (!rightPanelOpen || rightPanelTab !== 'chat') && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white shadow">
              {unreadChatCount}
            </span>
          )}
        </button>

        {/* Prominent Blue Share Button */}
        <button
          onClick={() => setShareModalOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-500/20 hover:bg-blue-500 transition active:scale-95"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
        </button>
      </div>
    </header>
  );
};
