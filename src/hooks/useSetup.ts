import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { checkSetup, runSetup, resetSetup } from "../lib/tauriApi";
import { toastError } from "../lib/toast";
import i18n from "../i18n";
import type { SetupStatus, SetupProgress, SetupLog } from "../types";

/** Maximum number of live log lines kept in memory. */
const MAX_LOG_LINES = 500;

export function useSetup() {
  const [status, setStatus] = useState<SetupStatus>("CHECKING");
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    checkSetup()
      .then((s) => setStatus(s))
      .catch((e) => {
        console.error("Failed to check setup:", e);
        toastError(i18n.t("toast.setupCheckFailed"));
        setStatus("NEEDED");
      });
  }, []);

  useEffect(() => {
    const unlisten = listen<SetupProgress>("setup-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<SetupLog>("setup-log", (event) => {
      setLogLines((prev) => {
        const next = [...prev, ...event.payload.lines];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const startSetup = useCallback(async () => {
    setStatus("IN_PROGRESS");
    setError(null);
    setProgress(null);
    setLogLines([]);
    try {
      await runSetup();
      setStatus("COMPLETE");
    } catch (e) {
      console.error("Setup failed:", e);
      toastError(i18n.t("toast.setupFailed"), String(e));
      setError(String(e));
      setStatus("ERROR");
    }
  }, []);

  const retry = useCallback(async () => {
    setError(null);
    await startSetup();
  }, [startSetup]);

  const reset = useCallback(async () => {
    try {
      await resetSetup();
      setStatus("NEEDED");
      setProgress(null);
      setError(null);
      setLogLines([]);
    } catch (e) {
      console.error("Failed to reset setup:", e);
      toastError(i18n.t("toast.setupResetFailed"));
    }
  }, []);

  return { status, progress, error, logLines, startSetup, retry, reset };
}
