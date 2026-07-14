import { useState, useCallback, useRef, useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SttSegment } from "../types";
import { startStt, cancelStt, startTranslate, cancelTranslate } from "../lib/tauriApi";
import { cleanSttSegments } from "../lib/sttCleaner";

export type PreviewPhase = "idle" | "stt" | "translating" | "done" | "error";

export interface PreviewResult {
  index: number;
  start: number;
  end: number;
  original: string;
  translated: string;
}

interface SttSegmentEvent {
  job_id: string;
  index: number;
  start: number;
  end: number;
  text: string;
}

interface TranslateSegmentEvent {
  job_id: string;
  index: number;
  original: string;
  translated: string;
}

export function usePreviewPipeline() {
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<PreviewResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cachedSegmentsRef = useRef<SttSegment[]>([]);
  const cachedFileRef = useRef<string | null>(null);
  const cachedRangeRef = useRef<{ start: number; end: number } | null>(null);
  const sttJobIdRef = useRef<string | null>(null);
  const translateJobIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      for (const unlisten of unlistenersRef.current) unlisten();
      unlistenersRef.current = [];
    };
  }, []);

  const cleanup = useCallback(async () => {
    for (const unlisten of unlistenersRef.current) unlisten();
    unlistenersRef.current = [];
    if (sttJobIdRef.current) {
      try { await cancelStt(sttJobIdRef.current); } catch {}
      sttJobIdRef.current = null;
    }
    if (translateJobIdRef.current) {
      try { await cancelTranslate(translateJobIdRef.current); } catch {}
      translateJobIdRef.current = null;
    }
  }, []);

  const startPreview = useCallback(
    async (filePath: string, presetId: string, startTime: number, endTime: number) => {
      await cleanup();

      // Check if STT cache can be reused
      const canReuseCache =
        cachedFileRef.current === filePath &&
        cachedRangeRef.current?.start === startTime &&
        cachedRangeRef.current?.end === endTime &&
        cachedSegmentsRef.current.length > 0;

      if (canReuseCache) {
        // Skip STT, go straight to translation
        await runTranslation(presetId);
        return;
      }

      // Full run: STT + Translation
      setPhase("stt");
      setProgress(0);
      setMessage("STT 시작...");
      setResults([]);
      setError(null);
      cachedSegmentsRef.current = [];

      try {
        const segments: SttSegment[] = [];

        // Listen for STT events
        const unlistenSeg = await listen<SttSegmentEvent>("stt-segment", (event) => {
          if (event.payload.job_id === sttJobIdRef.current) {
            segments.push({
              index: event.payload.index,
              start: event.payload.start,
              end: event.payload.end,
              text: event.payload.text,
            });
          }
        });
        unlistenersRef.current.push(unlistenSeg);

        const unlistenProgress = await listen<{ job_id: string; progress: number; message: string }>(
          "stt-progress",
          (event) => {
            if (event.payload.job_id === sttJobIdRef.current) {
              setProgress(event.payload.progress);
              setMessage(event.payload.message);
            }
          }
        );
        unlistenersRef.current.push(unlistenProgress);

        // Start STT with time range
        const sttJob = await startStt(filePath, undefined, startTime, endTime, presetId);
        sttJobIdRef.current = sttJob.id;

        // Wait for STT completion via job-updated event
        await new Promise<void>((resolve, reject) => {
          const listenPromise = listen<{ id: string; state: string; message?: string }>(
            "job-updated",
            (event) => {
              if (event.payload.id === sttJobIdRef.current) {
                if (event.payload.state === "DONE") {
                  resolve();
                } else if (event.payload.state === "FAILED") {
                  reject(new Error(event.payload.message || "STT failed"));
                } else if (event.payload.state === "CANCELED") {
                  reject(new Error("Cancelled"));
                }
              }
            }
          );
          listenPromise.then((unlisten) => unlistenersRef.current.push(unlisten));
        });

        // Cache STT results
        const cleaned = cleanSttSegments(segments);
        cachedSegmentsRef.current = cleaned;
        cachedFileRef.current = filePath;
        cachedRangeRef.current = { start: startTime, end: endTime };
        sttJobIdRef.current = null;

        // Proceed to translation
        await runTranslation(presetId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "Cancelled") {
          setPhase("error");
          setError(msg);
        }
      }
    },
    [cleanup],
  );

  const runTranslation = useCallback(
    async (presetId: string) => {
      setPhase("translating");
      setProgress(0);
      setMessage("번역 시작...");
      setError(null);

      const segments = cachedSegmentsRef.current;
      if (segments.length === 0) {
        setPhase("error");
        setError("No segments to translate");
        return;
      }

      // Build initial results with empty translations
      const initialResults: PreviewResult[] = segments.map((seg) => ({
        index: seg.index,
        start: seg.start,
        end: seg.end,
        original: seg.text,
        translated: "",
      }));
      setResults(initialResults);

      try {
        // Listen for translation events
        const unlistenSeg = await listen<TranslateSegmentEvent>(
          "translate-segment",
          (event) => {
            if (event.payload.job_id === translateJobIdRef.current) {
              setResults((prev) =>
                prev.map((r) =>
                  r.index === event.payload.index
                    ? { ...r, translated: event.payload.translated }
                    : r
                )
              );
            }
          }
        );
        unlistenersRef.current.push(unlistenSeg);

        const unlistenProgress = await listen<{ job_id: string; progress: number; message: string }>(
          "translate-progress",
          (event) => {
            if (event.payload.job_id === translateJobIdRef.current) {
              setProgress(event.payload.progress);
              setMessage(event.payload.message);
            }
          }
        );
        unlistenersRef.current.push(unlistenProgress);

        // Start translation
        const translateJob = await startTranslate(segments, presetId);
        translateJobIdRef.current = translateJob.id;

        // Wait for completion
        await new Promise<void>((resolve, reject) => {
          const listenPromise = listen<{ id: string; state: string; message?: string }>(
            "job-updated",
            (event) => {
              if (event.payload.id === translateJobIdRef.current) {
                if (event.payload.state === "DONE") {
                  resolve();
                } else if (event.payload.state === "FAILED") {
                  reject(new Error(event.payload.message || "Translation failed"));
                } else if (event.payload.state === "CANCELED") {
                  reject(new Error("Cancelled"));
                }
              }
            }
          );
          listenPromise.then((unlisten) => unlistenersRef.current.push(unlisten));
        });

        translateJobIdRef.current = null;
        setPhase("done");
        setProgress(100);
        setMessage("완료");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "Cancelled") {
          setPhase("error");
          setError(msg);
        }
      }
    },
    [],
  );

  const retryTranslation = useCallback(
    async (presetId: string) => {
      await cleanup();
      await runTranslation(presetId);
    },
    [cleanup, runTranslation],
  );

  const cancel = useCallback(async () => {
    await cleanup();
    setPhase("idle");
    setProgress(0);
    setMessage("");
  }, [cleanup]);

  const hasCachedStt = cachedSegmentsRef.current.length > 0;

  return {
    phase,
    progress,
    message,
    results,
    error,
    hasCachedStt,
    startPreview,
    retryTranslation,
    cancel,
  };
}
