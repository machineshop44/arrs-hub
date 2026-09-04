import { useCallback, useRef } from "react";

/** Close modal overlay only when pointer down/up both hit the backdrop (not text-selection drags). */
export function useModalBackdropClose(onClose: () => void) {
  const pointerDownOnBackdrop = useRef(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pointerDownOnBackdrop.current = event.target === event.currentTarget;
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        pointerDownOnBackdrop.current &&
        event.target === event.currentTarget
      ) {
        onClose();
      }
      pointerDownOnBackdrop.current = false;
    },
    [onClose],
  );

  return { onPointerDown, onPointerUp };
}
