/**
 * @fileoverview Shared hook to close floating popovers and dropdown menus when
 * clicking outside their container or pressing Escape.
 */

import { type RefObject, useEffect, useRef } from 'react';

/**
 * Returns true when an event target falls outside the given container element.
 */
export function shouldDismissOnOutsideEvent(
  container: { contains(node: unknown): boolean } | null,
  target: unknown,
): boolean {
  if (!container || target === null || target === undefined) return false;
  return !container.contains(target);
}

/**
 * Registers capture-phase pointer/mouse and Escape listeners while `isOpen` is true
 * so popovers close reliably even when sibling components stop event propagation.
 */
export function useClickOutside(
  isOpen: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerOrMouseDown = (event: PointerEvent | MouseEvent) => {
      if (shouldDismissOnOutsideEvent(ref.current, event.target)) {
        onCloseRef.current();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    };

    window.addEventListener('pointerdown', handlePointerOrMouseDown, true);
    window.addEventListener('mousedown', handlePointerOrMouseDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerOrMouseDown, true);
      window.removeEventListener('mousedown', handlePointerOrMouseDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, ref]);
}
