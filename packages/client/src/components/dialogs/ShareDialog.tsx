/**
 * @fileoverview Share session dialog.
 * Displays Server LAN IP, Port, Room Code, and copy shortcuts.
 * Automatically resolves the machine's actual LAN IP address instead of
 * loopback (127.0.0.1/localhost) so other devices on the LAN can connect.
 */

import React, { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, Network, Share2, Users, X } from 'lucide-react';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const ShareDialog: React.FC = () => {
  const { shareModalOpen, setShareModalOpen, roomInfo, roomPassword, serverInfo } =
    useWhiteboardStore();
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [includePassword, setIncludePassword] = useState(true);
  const [lanIps, setLanIps] = useState<string[]>([]);
  const [activeIp, setActiveIp] = useState<string>(serverInfo.host);

  // Query actual network interfaces from Electron main process
  useEffect(() => {
    let isSubscribed = true;
    const loadLanIps = async () => {
      try {
        if (window.electronAPI?.getLanAddresses) {
          const addresses = await window.electronAPI.getLanAddresses();
          if (isSubscribed && Array.isArray(addresses) && addresses.length > 0) {
            setLanIps(addresses);
            // If current serverInfo is loopback, prefer the machine's first LAN IP address
            const isLoopback =
              serverInfo.host === '127.0.0.1' ||
              serverInfo.host === 'localhost' ||
              serverInfo.host === '0.0.0.0';
            if (isLoopback && addresses[0]) {
              setActiveIp(addresses[0]);
            } else {
              setActiveIp(serverInfo.host);
            }
            return;
          }
        }
      } catch {
        // Fallback to serverInfo.host
      }
      if (isSubscribed) {
        setActiveIp(serverInfo.host);
      }
    };

    if (shareModalOpen) {
      loadLanIps();
    }
    return () => {
      isSubscribed = false;
    };
  }, [shareModalOpen, serverInfo.host]);

  if (!shareModalOpen || !roomInfo) {
    return null;
  }

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(roomInfo.code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleCopyPassword = async () => {
    if (!roomPassword) return;
    await navigator.clipboard.writeText(roomPassword);
    setCopiedPassword(true);
    setTimeout(() => setCopiedPassword(false), 2000);
  };

  const handleCopyAll = async () => {
    const lines = [
      'Join my LAN Whiteboard session!',
      `Server IP: ${activeIp}`,
      `Port: ${serverInfo.port}`,
      `Room Code: ${roomInfo.code}`,
    ];
    if (includePassword && roomPassword) {
      lines.push(`Password: ${roomPassword}`);
    }
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm select-none">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700/80 bg-slate-900 p-6 shadow-2xl text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-blue-400">
            <Share2 className="h-5 w-5" />
            <h2 className="text-base font-bold text-white">Share Session</h2>
          </div>
          <button
            onClick={() => setShareModalOpen(false)}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {/* Room Code Display */}
          <div className="rounded-xl border border-blue-500/30 bg-blue-950/30 p-4 text-center">
            <span className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider">
              Room Code
            </span>
            <div className="mt-1 flex items-center justify-center gap-3">
              <span className="text-3xl font-mono font-extrabold tracking-widest text-white">
                {roomInfo.code}
              </span>
              <button
                onClick={handleCopyCode}
                title="Copy Room Code"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition shadow-sm"
              >
                {copiedCode ? (
                  <Check className="h-4 w-4 text-emerald-300" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Network & Access details */}
          <div className="space-y-2.5 rounded-xl bg-slate-950/60 p-3.5 border border-slate-800 text-xs text-slate-300">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Network className="h-3.5 w-3.5 text-blue-400" /> LAN Server IP:
              </span>
              {lanIps.length > 1 ? (
                <select
                  value={activeIp}
                  onChange={(e) => setActiveIp(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-xs text-slate-100 outline-none focus:border-blue-500"
                >
                  {lanIps.map((ip) => (
                    <option key={ip} value={ip}>
                      {ip}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                  {activeIp}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">TCP Port:</span>
              <span className="font-mono font-medium text-slate-100">{serverInfo.port}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-indigo-400" /> Session Name:
              </span>
              <span className="font-semibold text-slate-100 truncate max-w-[160px]">
                {roomInfo.name}
              </span>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-slate-800/70">
              <span className="text-slate-400 flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-amber-400" /> Password:
              </span>
              {roomPassword ? (
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-medium text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 max-w-[120px] truncate">
                    {showPassword
                      ? roomPassword
                      : '•'.repeat(Math.min(12, Math.max(6, roomPassword.length)))}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
                  >
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    title="Copy password"
                    className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
                  >
                    {copiedPassword ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ) : (
                <span className="text-slate-500 italic">None (Public)</span>
              )}
            </div>
          </div>

          {roomPassword && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none px-1">
              <input
                type="checkbox"
                checked={includePassword}
                onChange={(e) => setIncludePassword(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-0"
              />
              <span>Include password when sharing invitation</span>
            </label>
          )}

          <button
            onClick={handleCopyAll}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-slate-800 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition border border-slate-700"
          >
            {copiedAll ? (
              <>
                <Check className="h-4 w-4 text-emerald-400" /> Copied Invitation Details!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" /> Copy Full Connection Details
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
