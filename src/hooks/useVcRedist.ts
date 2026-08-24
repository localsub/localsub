import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  cancelVcRedistInstall,
  getVcRedistState,
  installVcRedist,
} from "../lib/tauriApi";
import type { VcRedistOutcome, VcRedistProgress, VcRedistState } from "../types";

/**
 * Does this payload have the shape the card reads?
 *
 * The card renders inside App, so a malformed reply would throw during render
 * and take the whole window down — a broken runtime probe must not cost more
 * than the runtime itself. Anything unexpected is treated as "nothing to say".
 */
export function isUsableVcRedistState(value: unknown): value is VcRedistState {
  const state = value as VcRedistState | null | undefined;
  return (
    !!state &&
    typeof state === "object" &&
    !!state.status &&
    Array.isArray(state.status.missing) &&
    typeof state.status.core_blocked === "boolean"
  );
}

/**
 * Visual C++ runtime state, re-probed rather than remembered.
 *
 * The runtime is machine-global: the user can install it outside the app, and
 * declining the elevation prompt must not be a dead end. So this refreshes on
 * mount and after every attempt instead of caching a verdict — which is what
 * lets a declined prompt come back on the next launch with the button still
 * there.
 */
export function useVcRedist() {
  const [state, setState] = useState<VcRedistState | null>(null);
  const [progress, setProgress] = useState<VcRedistProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getVcRedistState();
      if (isUsableVcRedistState(next)) {
        setState(next);
      } else {
        console.error("Ignoring malformed Visual C++ runtime state:", next);
      }
    } catch (e) {
      // Never surfaced as a blocking error: failing to probe must not hide the
      // rest of the app.
      console.error("Failed to read Visual C++ runtime state:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<VcRedistProgress>("vcredist-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const install = useCallback(async (): Promise<VcRedistOutcome | null> => {
    setInstalling(true);
    setError(null);
    setProgress(null);
    try {
      return await installVcRedist();
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      // Refreshed on both paths so the attempt record — including a failed
      // one — is what the retry screen reads back.
      setInstalling(false);
      setProgress(null);
      await refresh();
    }
  }, [refresh]);

  const cancel = useCallback(async () => {
    try {
      await cancelVcRedistInstall();
    } catch (e) {
      console.error("Failed to cancel the runtime install:", e);
    }
  }, []);

  return { state, progress, installing, error, install, cancel, refresh };
}
