import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ServerStatus } from "../types";
import { getServerStatus, startServer, stopServer } from "../lib/tauriApi";
import { toastError } from "../lib/toast";
import i18n from "../i18n";

export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus>("STOPPED");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Get initial status
    getServerStatus().then(setStatus).catch((e) => {
      console.error("Failed to get server status:", e);
      toastError(i18n.t("toast.serverConnectFailed"));
    });

    // Listen for status changes
    const unlisten = listen<ServerStatus>("server-status", (event) => {
      setStatus(event.payload);
      if (event.payload !== "ERROR") {
        setError(null);
      }
    });

    // Listen for server crash — auto-restart if not in pipeline (model switching)
    const unlistenCrash = listen("server-crashed", () => {
      setStatus("ERROR");
      setError("Server crashed");
      toastError(i18n.t("toast.serverCrashed"));
      // Auto-restart after 2 seconds, but only if server is still in ERROR state
      // (pipeline's restartServer would have already set it to STARTING/RUNNING)
      setTimeout(async () => {
        try {
          const currentStatus = await getServerStatus();
          if (currentStatus === "ERROR" || currentStatus === "STOPPED") {
            await startServer();
          }
        } catch (e) {
          console.error("Auto-restart failed:", e);
        }
      }, 3000);
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenCrash.then((fn) => fn());
    };
  }, []);

  const start = async () => {
    setError(null);
    try {
      await startServer();
    } catch (e) {
      setError(String(e));
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await stopServer();
    } catch (e) {
      setError(String(e));
    }
  };

  return { status, error, start, stop };
}
