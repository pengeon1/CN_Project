/**
 * @fileoverview Connection modal dialog allowing users to host or join a session.
 * Supports Server LAN IP, Port, Username, Room Code, and optional passwords.
 */

import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  KeyRound,
  Loader2,
  LogIn,
  Network,
  PlusCircle,
  Radar,
  X,
} from 'lucide-react';
import type { DiscoveredServer } from '../../types/ipc.js';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const ConnectDialog: React.FC = () => {
  const {
    connectModalOpen,
    connectionStatus,
    connectionError,
    serverInfo,
    setConnectModalOpen,
    connectToServer,
  } = useWhiteboardStore();

  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [host, setHost] = useState(serverInfo.host);
  const [port, setPort] = useState(String(serverInfo.port));
  const [username, setUsername] = useState('Alice');
  const [roomName, setRoomName] = useState('Project Brainstorm');
  const [roomCode, setRoomCode] = useState('');
  const [password, setPassword] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [allowNameChanges, setAllowNameChanges] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** null until the first scan finishes, so "nothing found" is not shown prematurely. */
  const [servers, setServers] = useState<DiscoveredServer[] | null>(null);

  const scanLan = async () => {
    const discover = window.electronAPI?.discoverServers;
    if (!discover || scanning) return;
    setScanning(true);
    try {
      setServers(await discover());
    } catch {
      setServers([]);
    } finally {
      setScanning(false);
    }
  };

  // Automatically scan for LAN servers when switching to or opening the Join tab
  useEffect(() => {
    if (tab === 'join' && window.electronAPI?.discoverServers && servers === null && !scanning) {
      void scanLan();
    }
  }, [tab, scanning, servers]);

  if (!connectModalOpen) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;

    setIsSubmitting(true);
    await connectToServer({
      host: host.trim() || '127.0.0.1',
      port: parseInt(port, 10) || 4000,
      username: username.trim(),
      action: tab,
      roomName: tab === 'create' ? roomName.trim() : undefined,
      roomCode: tab === 'join' ? roomCode.trim().toUpperCase() : undefined,
      password: password.trim() || undefined,
      allowNameChanges: tab === 'create' ? allowNameChanges : undefined,
    });
    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm select-none">
      <div className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900 p-6 shadow-2xl text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-blue-400">
            <Network className="h-5 w-5" />
            <h2 className="text-base font-bold text-white">Connect to Whiteboard</h2>
          </div>
          <button
            onClick={() => setConnectModalOpen(false)}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Action Tabs */}
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-950/60 p-1 border border-slate-800">
          <button
            type="button"
            onClick={() => setTab('create')}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              tab === 'create'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <PlusCircle className="h-3.5 w-3.5" />
            Host Session
          </button>
          <button
            type="button"
            onClick={() => setTab('join')}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              tab === 'join'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LogIn className="h-3.5 w-3.5" />
            Join Session
          </button>
        </div>

        {/* Error notification */}
        {connectionError && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 border border-red-500/20 p-2.5 text-xs text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{connectionError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          {/* LAN discovery (manual IP entry below always remains available) */}
          <div>
            <button
              type="button"
              onClick={() => void scanLan()}
              disabled={scanning || !window.electronAPI?.discoverServers}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-blue-500 disabled:opacity-60"
            >
              {scanning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radar className="h-3.5 w-3.5" />
              )}
              {scanning ? 'Scanning the network…' : 'Find servers on this network'}
            </button>
            {servers !== null && (
              <ul className="mt-2 space-y-1">
                {servers.length === 0 && (
                  <li className="px-1 text-[11px] text-slate-400">
                    No servers answered. Check the server is running on the same network, or type
                    its IP below.
                  </li>
                )}
                {servers.map((s) => (
                  <li key={`${s.host}:${s.port}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setHost(s.host);
                        setPort(String(s.port));
                      }}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-1.5 text-left text-xs transition ${
                        host === s.host && port === String(s.port)
                          ? 'border-blue-500 bg-blue-600/15'
                          : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'
                      }`}
                    >
                      <span className="font-semibold">{s.name}</span>
                      <span className="text-slate-400">
                        {s.host}:{s.port} · {s.rooms} room{s.rooms === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* LAN Connection Details */}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Server LAN IP
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">Port</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="4000"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Your Name</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. Alice"
              className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Host Tab Specifics */}
          {tab === 'create' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Session Title
                </label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="e.g. Brainstorming"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((open) => !open)}
                  aria-expanded={settingsOpen}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-slate-300"
                >
                  Change settings
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${settingsOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                {settingsOpen && (
                  <label className="flex cursor-pointer items-start gap-2.5 border-t border-slate-800 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={allowNameChanges}
                      onChange={(event) => setAllowNameChanges(event.currentTarget.checked)}
                      className="mt-0.5 accent-blue-500"
                    />
                    <span>
                      <span className="block text-xs font-medium text-slate-200">
                        Allow participants to change their names
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        Participants can rename themselves from the participants list.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            </div>
          )}

          {/* Join Tab Specifics */}
          {tab === 'join' && (
            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                6-Character Room Code
              </label>
              <input
                type="text"
                required
                maxLength={6}
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="e.g. AB23CD"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs font-mono font-bold tracking-widest text-center text-blue-400 uppercase focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {/* Optional Password */}
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">
              Room Password <span className="text-slate-500 font-normal">(Optional)</span>
            </label>
            <div className="relative">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for public room"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/80 pl-9 pr-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
              />
              <KeyRound className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
            </div>
          </div>

          {/* Action button */}
          <button
            type="submit"
            disabled={isSubmitting || connectionStatus === 'connecting'}
            className="w-full mt-2 flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-500/20 hover:bg-blue-500 disabled:opacity-50 transition"
          >
            {isSubmitting || connectionStatus === 'connecting' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting over TCP...
              </>
            ) : tab === 'create' ? (
              'Create & Host Room'
            ) : (
              'Join Whiteboard Room'
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
