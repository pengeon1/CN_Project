/**
 * @fileoverview Collapsible right sidebar panel.
 * Houses the real-time group chat channel and active room participant list.
 */

import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Shield, Users, X } from 'lucide-react';
import { Role } from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const RightPanel: React.FC = () => {
  const {
    rightPanelOpen,
    rightPanelTab,
    chatMessages,
    unreadChatCount,
    participants,
    currentUser,
    setRightPanelOpen,
    setRightPanelTab,
    sendChatMessage,
  } = useWhiteboardStore();

  const [inputDraft, setInputDraft] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rightPanelTab === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, rightPanelTab]);

  if (!rightPanelOpen) {
    return null;
  }

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputDraft.trim()) return;
    sendChatMessage(inputDraft.trim());
    setInputDraft('');
  };

  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <aside className="relative flex h-full w-80 flex-col border-l border-slate-800 bg-[#0F172A] text-slate-200 z-20 shadow-2xl select-none">
      {/* Panel Header with Tabs & Close button */}
      <div className="flex h-14 items-center justify-between border-b border-slate-800 px-4">
        <div className="flex items-center gap-1 rounded-lg bg-slate-900/80 p-0.5 border border-slate-800">
          <button
            onClick={() => setRightPanelTab('chat')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
              rightPanelTab === 'chat'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
            {unreadChatCount > 0 && rightPanelTab !== 'chat' && (
              <span className="flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white shadow">
                {unreadChatCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setRightPanelTab('participants')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
              rightPanelTab === 'participants'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            Participants ({participants.length})
          </button>
        </div>

        <button
          onClick={() => setRightPanelOpen(false)}
          title="Close panel"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab 1: Chat Stream */}
      {rightPanelTab === 'chat' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 space-y-3 select-text">
            {chatMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-xs text-slate-500">
                <MessageSquare className="h-8 w-8 mb-2 stroke-1 opacity-50" />
                <p>No messages yet.</p>
                <p className="mt-0.5">Start collaborating with your peers!</p>
              </div>
            ) : (
              chatMessages.map((msg) => {
                if (msg.isSystem) {
                  return (
                    <div
                      key={msg.id}
                      className="text-center text-[11px] font-medium text-slate-500 my-1 italic"
                    >
                      {msg.text}
                    </div>
                  );
                }

                const isMe = currentUser?.id === msg.userId;

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5 text-[11px]">
                      <span style={{ color: msg.color }} className="font-semibold">
                        {msg.username}
                      </span>
                      <span className="text-[10px] text-slate-500">{formatTime(msg.ts)}</span>
                    </div>

                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed break-words shadow-sm ${
                        isMe
                          ? 'bg-blue-600 text-white rounded-br-xs'
                          : 'bg-slate-800 text-slate-100 rounded-bl-xs border border-slate-700/60'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Chat Message Input Form with Green Send Button */}
          <form
            onSubmit={handleSend}
            className="flex items-center gap-2 border-t border-slate-800 bg-slate-900/60 p-3"
          >
            <input
              type="text"
              value={inputDraft}
              onChange={(e) => setInputDraft(e.target.value)}
              placeholder="Write a message..."
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950/80 px-3.5 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none transition"
            />
            <button
              type="submit"
              disabled={!inputDraft.trim()}
              title="Send Message"
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-40 disabled:hover:bg-emerald-500 transition shadow-sm shadow-emerald-500/20 flex-shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}

      {/* Tab 2: Participants List */}
      {rightPanelTab === 'participants' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {participants.map((p) => {
            const isMe = currentUser?.id === p.id;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-xl border border-slate-800/80 bg-slate-900/50 p-2.5 transition hover:bg-slate-800/40"
              >
                <div className="flex items-center gap-2.5">
                  <div
                    style={{ backgroundColor: p.color }}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm ring-1 ring-white/20"
                  >
                    {p.username.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-slate-200">{p.username}</span>
                      {isMe && (
                        <span className="rounded bg-blue-500/20 px-1.5 py-0.2 text-[9px] font-bold text-blue-400">
                          YOU
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500 flex items-center gap-1 mt-0.5">
                      {p.role === Role.HOST && <Shield className="h-2.5 w-2.5 text-amber-400" />}
                      {p.role}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
};
