import React, { useEffect, useState } from 'react';
import { UserRoundPen, X } from 'lucide-react';
import { MAX_USERNAME_LENGTH } from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

export const ProfileSettingsDialog: React.FC = () => {
  const { profileSettingsOpen, currentUser, setProfileSettingsOpen, updateUsername } =
    useWhiteboardStore();
  const [username, setUsername] = useState(currentUser?.username ?? '');

  useEffect(() => {
    if (profileSettingsOpen) setUsername(currentUser?.username ?? '');
  }, [profileSettingsOpen, currentUser?.username]);

  if (!profileSettingsOpen || !currentUser) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || trimmedUsername.length > MAX_USERNAME_LENGTH) return;
    updateUsername(trimmedUsername);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-700/80 bg-slate-900 p-6 text-slate-100 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2 text-blue-400">
            <UserRoundPen className="h-5 w-5" />
            <h2 className="text-base font-bold text-white">Profile settings</h2>
          </div>
          <button
            type="button"
            onClick={() => setProfileSettingsOpen(false)}
            aria-label="Close profile settings"
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-4 block text-xs font-medium text-slate-400" htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          autoFocus
          required
          maxLength={MAX_USERNAME_LENGTH}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          Your new name will be shown to everyone in this session.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setProfileSettingsOpen(false)}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!username.trim() || username.trim() === currentUser.username}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save name
          </button>
        </div>
      </form>
    </div>
  );
};
