/**
 * @fileoverview Phase 14 client logic: presentation state, stale-presentation recovery and
 * version list handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEnvelope,
  generateUuid,
  MessageType,
  PRESENTATION_STALE_MS,
  Role,
} from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../src/store/useWhiteboardStore.js';
import { TOOL_SHORTCUTS } from '../src/hooks/useKeyboardShortcuts.js';

const me = (role: Role) => ({ id: generateUuid(), username: 'Me', color: '#3B82F6', role });

describe('presentation and versions (client store)', () => {
  beforeEach(() => {
    useWhiteboardStore.setState({
      presentation: { active: false, receivedAt: 0 },
      versions: [],
      currentUser: me(Role.EDITOR),
    });
  });
  afterEach(() => vi.useRealTimers());

  it('mirrors PRESENTATION messages from the host', () => {
    const view = { active: true, viewport: { x: 10, y: 20, zoom: 2 } };
    useWhiteboardStore
      .getState()
      .handleIncomingEnvelope(createEnvelope(MessageType.PRESENTATION, view, { room: 'ABC234' }));
    expect(useWhiteboardStore.getState().presentation).toMatchObject(view);
    useWhiteboardStore
      .getState()
      .handleIncomingEnvelope(createEnvelope(MessageType.PRESENTATION, { active: false }));
    expect(useWhiteboardStore.getState().presentation.active).toBe(false);
  });

  it('lets a follower recover when the host goes silent, but never ends the host own session', () => {
    vi.useFakeTimers();
    useWhiteboardStore.setState({ presentation: { active: true, receivedAt: Date.now() } });
    useWhiteboardStore.getState().endStalePresentation();
    expect(useWhiteboardStore.getState().presentation.active).toBe(true); // still fresh

    vi.advanceTimersByTime(PRESENTATION_STALE_MS + 1);
    useWhiteboardStore.getState().endStalePresentation();
    expect(useWhiteboardStore.getState().presentation.active).toBe(false);

    useWhiteboardStore.setState({
      currentUser: me(Role.HOST),
      presentation: { active: true, receivedAt: 0 },
    });
    useWhiteboardStore.getState().endStalePresentation();
    expect(useWhiteboardStore.getState().presentation.active).toBe(true);
  });

  it('stores the version list sent by the server and has a laser shortcut', () => {
    const versions = [
      { id: generateUuid(), name: 'v1', ts: 1, createdBy: null, auto: true, objectCount: 3 },
    ];
    useWhiteboardStore
      .getState()
      .handleIncomingEnvelope(createEnvelope(MessageType.VERSION_LIST, { versions }));
    expect(useWhiteboardStore.getState().versions).toEqual(versions);
    expect(TOOL_SHORTCUTS.k).toBe('laser');
  });
});
