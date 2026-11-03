/**
 * @fileoverview Top navigation bar matching the design reference.
 * Houses session title, last-saved status, participant avatar stack,
 * search button, chat toggle with unread counter, and prominent Share button.
 */

import React from 'react';
import { ArrowLeft, LogIn, MessageSquare, Moon, Search, Share2, Sun } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const TopBar: React.FC = () => {
  const {
    roomInfo,
    currentUser,
    participants,
    rightPanelOpen,
    unreadChatCount,
    isDarkTheme,
    setRightPanelOpen,
    setShareModalOpen,
    setConnectModalOpen,
    disconnectFromServer,
    toggleTheme,
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
            {roomInfo ? 'All changes saved locally' : 'No active session'}
          </span>
        </div>
      </div>

      {/* Right controls: Avatars, Search, Chat, Share, Theme */}
      <div className="flex items-center gap-2.5">
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
          {unreadChatCount > 0 && !rightPanelOpen && (
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
