import { useRef, useState, useCallback } from "react";

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export function useHistory<T>(initial: T, maxSize = 50) {
  const stateRef = useRef<HistoryState<T>>({
    past: [],
    present: initial,
    future: [],
  });
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  const present = stateRef.current.present;

  const push = useCallback(
    (value: T) => {
      const s = stateRef.current;
      const past = [...s.past, s.present];
      if (past.length > maxSize) past.shift();
      stateRef.current = { past, present: value, future: [] };
      rerender();
    },
    [maxSize, rerender],
  );

  const undo = useCallback(() => {
    const s = stateRef.current;
    if (s.past.length === 0) return;
    const previous = s.past[s.past.length - 1];
    const past = s.past.slice(0, -1);
    stateRef.current = {
      past,
      present: previous,
      future: [s.present, ...s.future],
    };
    rerender();
  }, [rerender]);

  const redo = useCallback(() => {
    const s = stateRef.current;
    if (s.future.length === 0) return;
    const next = s.future[0];
    const future = s.future.slice(1);
    stateRef.current = {
      past: [...s.past, s.present],
      present: next,
      future,
    };
    rerender();
  }, [rerender]);

  const reset = useCallback(
    (value: T) => {
      stateRef.current = { past: [], present: value, future: [] };
      rerender();
    },
    [rerender],
  );

  const canUndo = stateRef.current.past.length > 0;
  const canRedo = stateRef.current.future.length > 0;

  return { present, push, undo, redo, reset, canUndo, canRedo };
}
