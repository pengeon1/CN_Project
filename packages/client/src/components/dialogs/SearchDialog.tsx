/**
 * @fileoverview Find on board dialog.
 * Allows searching across canvas text, sticky notes, shapes, chat messages, and participants.
 * Selecting a result centers the canvas on that object and highlights it.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  Image as ImageIcon,
  MessageSquare,
  Search,
  Square,
  StickyNote,
  Type,
  User,
  X,
} from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

interface SearchResult {
  id: string;
  category: 'sticky' | 'text' | 'shape' | 'image' | 'chat' | 'user';
  title: string;
  snippet?: string;
  action: () => void;
}

export const SearchDialog: React.FC = () => {
  const {
    searchOpen,
    setSearchOpen,
    objects,
    chatMessages,
    participants,
    focusObject,
    setRightPanelOpen,
    setRightPanelTab,
  } = useWhiteboardStore();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) {
      setQuery('');
      setSelectedIndex(0);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [searchOpen]);

  const results: SearchResult[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const matches: SearchResult[] = [];

    // 1. Search canvas objects (sticky notes, text boxes, shapes)
    for (const obj of Object.values(objects)) {
      if (obj.type === 'shape') {
        const text = (obj.text ?? '').trim();
        if (obj.shapeType === 'sticky_note') {
          if (text.toLowerCase().includes(q) || 'sticky note'.includes(q)) {
            matches.push({
              id: `obj-${obj.id}`,
              category: 'sticky',
              title: text ? text.slice(0, 45) : 'Empty Sticky Note',
              snippet: text.length > 45 ? text.slice(45, 100) + '…' : undefined,
              action: () => focusObject(obj.id),
            });
          }
        } else if (obj.shapeType === 'text') {
          if (text.toLowerCase().includes(q) || 'text box'.includes(q)) {
            matches.push({
              id: `obj-${obj.id}`,
              category: 'text',
              title: text ? text.slice(0, 45) : 'Empty Text Box',
              snippet: text.length > 45 ? text.slice(45, 100) + '…' : undefined,
              action: () => focusObject(obj.id),
            });
          }
        } else {
          if (text.toLowerCase().includes(q)) {
            matches.push({
              id: `obj-${obj.id}`,
              category: 'shape',
              title: `${obj.shapeType === 'ellipse' ? 'Ellipse' : 'Rectangle'}: ${text.slice(0, 40)}`,
              snippet: text.length > 40 ? text.slice(40, 90) + '…' : undefined,
              action: () => focusObject(obj.id),
            });
          }
        }
      } else if (obj.type === 'image') {
        const author = participants.find((p) => p.id === obj.authorId);
        const name = author?.username ? `Image by ${author.username}` : 'Whiteboard Image';
        if (name.toLowerCase().includes(q) || 'image'.includes(q)) {
          matches.push({
            id: `obj-${obj.id}`,
            category: 'image',
            title: name,
            action: () => focusObject(obj.id),
          });
        }
      }
    }

    // 2. Search chat history
    for (const msg of chatMessages) {
      const text = msg.text ?? '';
      const authorName = msg.username ?? 'User';
      if (text.toLowerCase().includes(q) || authorName.toLowerCase().includes(q)) {
        matches.push({
          id: `chat-${msg.id}`,
          category: 'chat',
          title: `${authorName}: ${text ? text.slice(0, 40) : 'Chat message'}`,
          snippet: text.length > 40 ? text.slice(40, 90) + '…' : undefined,
          action: () => {
            setRightPanelOpen(true);
            setRightPanelTab('chat');
            setSearchOpen(false);
          },
        });
      }
    }

    // 3. Search participants
    for (const p of participants) {
      const username = p.username ?? 'Collaborator';
      const roleStr = p.role ?? 'EDITOR';
      if (username.toLowerCase().includes(q) || roleStr.toLowerCase().includes(q)) {
        matches.push({
          id: `user-${p.id}`,
          category: 'user',
          title: username,
          snippet: `Role: ${roleStr}`,
          action: () => {
            setRightPanelOpen(true);
            setRightPanelTab('participants');
            setSearchOpen(false);
          },
        });
      }
    }

    return matches.slice(0, 20);
  }, [
    query,
    objects,
    chatMessages,
    participants,
    focusObject,
    setRightPanelOpen,
    setRightPanelTab,
    setSearchOpen,
  ]);

  if (!searchOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setSearchOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        results.length > 0 ? (prev - 1 + results.length) % results.length : 0,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        results[selectedIndex].action();
      }
    }
  };

  const getIcon = (category: SearchResult['category']) => {
    switch (category) {
      case 'sticky':
        return <StickyNote className="h-4 w-4 text-amber-400" />;
      case 'text':
        return <Type className="h-4 w-4 text-blue-400" />;
      case 'shape':
        return <Square className="h-4 w-4 text-emerald-400" />;
      case 'image':
        return <ImageIcon className="h-4 w-4 text-purple-400" />;
      case 'chat':
        return <MessageSquare className="h-4 w-4 text-cyan-400" />;
      case 'user':
        return <User className="h-4 w-4 text-pink-400" />;
      default:
        return <Circle className="h-4 w-4 text-slate-400" />;
    }
  };

  const getBadge = (category: SearchResult['category']) => {
    switch (category) {
      case 'sticky':
        return (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
            Sticky
          </span>
        );
      case 'text':
        return (
          <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">
            Text
          </span>
        );
      case 'shape':
        return (
          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
            Shape
          </span>
        );
      case 'image':
        return (
          <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300">
            Image
          </span>
        );
      case 'chat':
        return (
          <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
            Chat
          </span>
        );
      case 'user':
        return (
          <span className="rounded bg-pink-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-pink-300">
            User
          </span>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-slate-950/60 p-4 backdrop-blur-sm"
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="relative flex w-full max-w-lg flex-col rounded-2xl border border-slate-700/80 bg-slate-900/95 p-4 text-slate-100 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-700 bg-slate-950/90 px-3.5 py-2.5 focus-within:border-blue-500 transition">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search text, sticky notes, shapes, chat, users..."
            className="flex-1 bg-transparent text-xs text-slate-100 placeholder-slate-500 outline-none"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="text-slate-500 hover:text-slate-300 transition"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
            Esc
          </kbd>
        </div>

        {/* Results List */}
        <div className="mt-3 max-h-72 overflow-y-auto space-y-1">
          {query.trim() === '' ? (
            <div className="py-6 text-center text-xs text-slate-500">
              Type to search text notes, sticky notes, chat messages, or collaborators.
            </div>
          ) : results.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-500">
              No matching elements found for &quot;{query}&quot;
            </div>
          ) : (
            results.map((res, idx) => (
              <button
                key={res.id}
                onClick={res.action}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition ${
                  selectedIndex === idx
                    ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                    : 'hover:bg-slate-800/60 text-slate-200 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-800">
                    {getIcon(res.category)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{res.title}</div>
                    {res.snippet && (
                      <div className="truncate text-[11px] text-slate-400">{res.snippet}</div>
                    )}
                  </div>
                </div>
                <div className="shrink-0">{getBadge(res.category)}</div>
              </button>
            ))
          )}
        </div>

        {/* Footer shortcuts hint */}
        {results.length > 0 && (
          <div className="mt-3 flex items-center justify-between border-t border-slate-800/80 pt-2 text-[10px] text-slate-500">
            <span>
              {results.length} result{results.length === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              <span>
                Navigate <kbd className="rounded bg-slate-800 px-1">↑</kbd>{' '}
                <kbd className="rounded bg-slate-800 px-1">↓</kbd>
              </span>
              <span>
                Jump <kbd className="rounded bg-slate-800 px-1">Enter</kbd>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
