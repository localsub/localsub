import { useCallback, useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Job, SttSegment, SubtitleLine, JobStatus, JobStage, JobSourceType } from "../types";
import {
  startStt,
  cancelStt,
  startDiarization,
  cancelDiarization,
  startTranslate,
  cancelTranslate,
  saveJobSubtitles,
  restartServer,
  exportSubtitles,
  getConfig,
  getModelManifest,
  readSubtitleFile,
  type ExportSegmentInput,
} from "../lib/tauriApi";
import { toastError, toastWarning } from "../lib/toast";
import { cleanSttSegments } from "../lib/sttCleaner";
import { shouldCheckpoint, mergeCheckpointLines } from "../lib/checkpoint";
import { estimateRemaining, formatEta, ETA_WINDOW } from "../lib/eta";
import i18n from "../i18n";

interface SttSegmentEvent {
  job_id: string;
  index: number;
  start: number;
  end: number;
  text: string;
}

interface DiarizationSegmentEvent {
  job_id: string;
  index: number;
  speaker: string;
}

interface TranslateSegmentEvent {
  job_id: string;
  index: number;
  original: string;
  translated: string;
}

export interface JobUpdate {
  status?: JobStatus;
  stage?: JobStage;
  progress?: number;
  error?: string;
  duration?: number;
  /** Estimated remaining time for the current stage (ms). null = unknown/not applicable. */
  etaMs?: number | null;
  /** Number of translated lines persisted by the last checkpoint save. */
  translated_count?: number;
}

interface ActivePipeline {
  dashboardJobId: string;
  sttJobId: string | null;
  diarizationJobId: string | null;
  translateJobId: string | null;
  segments: SttSegment[];
  translations: Map<number, string>;
  speakerMap: Map<number, string>;
  enableDiarization: boolean;
  skipTranslation: boolean;
  presetId?: string;
  filePath: string;
  phase: "stt" | "diarizing" | "translating" | "done" | "error";
  /**
   * Lines already translated by a previous (interrupted) run. When set,
   * `segments` holds only the remaining untranslated segments and every
   * save merges these base lines back in — otherwise the partial save
   * would overwrite (destroy) the earlier translations on disk.
   */
  resumeBaseLines?: SubtitleLine[];
}

// 주의: 이 결과를 직접 저장(saveJobSubtitles)하지 말 것 — 재개된 잡에서는
// resumeBaseLines가 빠져 기번역분이 파괴된다. 저장은 buildPersistedLines로.
function buildSubtitleLines(pipeline: ActivePipeline): SubtitleLine[] {
  return pipeline.segments.map((seg) => ({
    id: crypto.randomUUID(),
    index: seg.index,
    start_time: seg.start,
    end_time: seg.end,
    original_text: seg.text,
    translated_text: pipeline.translations.get(seg.index) ?? "",
    speaker: pipeline.speakerMap.get(seg.index),
    status: pipeline.translations.has(seg.index)
      ? ("translated" as const)
      : ("untranslated" as const),
  }));
}

/**
 * Lines to persist for a pipeline: the current run's lines, merged over the
 * previous run's translated lines when resuming. Used at every save point
 * (translation start, checkpoints, failure, finalize) so a resumed job never
 * loses the translations done before the interruption.
 */
function buildPersistedLines(pipeline: ActivePipeline): SubtitleLine[] {
  const lines = buildSubtitleLines(pipeline);
  return pipeline.resumeBaseLines
    ? mergeCheckpointLines(pipeline.resumeBaseLines, lines)
    : lines;
}

function countTranslated(lines: SubtitleLine[]): number {
  return lines.filter((l) => l.status === "translated").length;
}

export function usePipeline(
  onJobUpdate: (dashboardJobId: string, update: JobUpdate) => void,
  onLiveSegments?: (jobId: string, lines: SubtitleLine[]) => void,
) {
  const pipelinesRef = useRef<Map<string, ActivePipeline>>(new Map());
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  // Per-job translate-segment arrival timestamps for ETA estimation.
  // estimateRemaining uses the last ETA_WINDOW samples, so window+1 is enough.
  const etaTimesRef = useRef<Map<string, number[]>>(new Map());
  // Last emitted ETA label per job — etaMs updates are skipped while the
  // user-visible (minute-granularity) label is unchanged, so jobs.json isn't
  // rewritten on every segment just to carry a transient value.
  const etaLabelRef = useRef<Map<string, string>>(new Map());

  // Listen for job-updated events
  useEffect(() => {
    const p1 = listen<Job>("job-updated", (event) => {
      const job = event.payload;

      for (const [, pipeline] of pipelinesRef.current) {
        // Match STT job
        if (pipeline.sttJobId === job.id) {
          if (job.state === "RUNNING") {
            // Ignore STT progress updates after we've moved to translation phase
            if (pipeline.phase !== "stt") return;
            onJobUpdate(pipeline.dashboardJobId, {
              status: "processing",
              stage: "stt",
              progress: Math.round(job.progress),
            });
          } else if (job.state === "DONE") {
            // Ignore duplicate DONE if already past STT phase
            if (pipeline.phase !== "stt") return;

            // Clean STT output before passing to next stage
            pipeline.segments = cleanSttSegments(pipeline.segments);

            // Calculate duration from last segment
            const lastSeg = pipeline.segments[pipeline.segments.length - 1];
            const duration = lastSeg ? Math.ceil(lastSeg.end) : 0;

            // Mark STT as 100% complete with duration
            onJobUpdate(pipeline.dashboardJobId, {
              status: "processing",
              stage: "stt",
              progress: 100,
              duration,
            });

            if (pipeline.enableDiarization) {
              pipeline.phase = "diarizing";
              chainDiarization(pipeline);
            } else if (pipeline.skipTranslation) {
              pipeline.phase = "done";
              finalizePipeline(pipeline);
            } else {
              pipeline.phase = "translating";
              chainTranslation(pipeline);
            }
          } else if (job.state === "FAILED") {
            pipeline.phase = "error";
            onJobUpdate(pipeline.dashboardJobId, {
              status: "failed",
              stage: "error",
              error: job.error ?? "STT failed",
            });
            pipelinesRef.current.delete(pipeline.dashboardJobId);
          } else if (job.state === "CANCELED") {
            pipelinesRef.current.delete(pipeline.dashboardJobId);
            onJobUpdate(pipeline.dashboardJobId, {
              status: "pending",
              stage: "stt",
              progress: 0,
            });
          }
          return;
        }

        // Match diarization job
        if (pipeline.diarizationJobId === job.id) {
          if (job.state === "RUNNING") {
            onJobUpdate(pipeline.dashboardJobId, {
              status: "processing",
              stage: "diarizing",
              progress: Math.round(job.progress),
            });
          } else if (job.state === "DONE") {
            if (pipeline.skipTranslation) {
              pipeline.phase = "done";
              finalizePipeline(pipeline);
            } else {
              pipeline.phase = "translating";
              chainTranslation(pipeline);
            }
          } else if (job.state === "FAILED") {
            if (pipeline.skipTranslation) {
              // Diarization failed, no translation — finalize with STT results
              console.warn("Diarization failed, finalizing with STT only");
              pipeline.phase = "done";
              finalizePipeline(pipeline);
            } else {
              // Diarization failed — skip and continue to translation (graceful fallback)
              console.warn("Diarization failed, skipping to translation");
              pipeline.phase = "translating";
              chainTranslation(pipeline);
            }
          } else if (job.state === "CANCELED") {
            pipelinesRef.current.delete(pipeline.dashboardJobId);
            onJobUpdate(pipeline.dashboardJobId, {
              status: "pending",
              stage: "stt",
              progress: 0,
            });
          }
          return;
        }

        // Match translate job
        if (pipeline.translateJobId === job.id) {
          if (job.state === "RUNNING") {
            if (pipeline.phase === "done" || pipeline.phase === "error") return;
            onJobUpdate(pipeline.dashboardJobId, {
              status: "processing",
              stage: "translating",
              progress: Math.round(job.progress),
            });
          } else if (job.state === "DONE") {
            if (pipeline.phase === "done") return;
            pipeline.phase = "done";
            finalizePipeline(pipeline);
          } else if (job.state === "FAILED") {
            // Translation failed — save progress so far but mark as failed
            pipeline.phase = "error";
            const lines = buildPersistedLines(pipeline);
            saveJobSubtitles(pipeline.dashboardJobId, lines).catch(() => {});
            etaTimesRef.current.delete(pipeline.dashboardJobId);
      etaLabelRef.current.delete(pipeline.dashboardJobId);
            onJobUpdate(pipeline.dashboardJobId, {
              status: "failed",
              stage: "translating",
              progress: 0,
              error: job.message ?? "Translation failed",
              etaMs: null,
            });
            pipelinesRef.current.delete(pipeline.dashboardJobId);
          } else if (job.state === "CANCELED") {
            pipeline.phase = "done";
            finalizePipeline(pipeline);
          }
          return;
        }
      }
    });

    const p2 = listen<SttSegmentEvent>("stt-segment", (event) => {
      const seg = event.payload;
      for (const [, pipeline] of pipelinesRef.current) {
        if (pipeline.sttJobId === seg.job_id) {
          pipeline.segments.push({
            index: seg.index,
            start: seg.start,
            end: seg.end,
            text: seg.text,
          });
          onLiveSegments?.(pipeline.dashboardJobId, buildSubtitleLines(pipeline));
          return;
        }
      }
    });

    const p2b = listen<DiarizationSegmentEvent>("diar-segment", (event) => {
      const seg = event.payload;
      for (const [, pipeline] of pipelinesRef.current) {
        if (pipeline.diarizationJobId === seg.job_id) {
          pipeline.speakerMap.set(seg.index, seg.speaker);
          onLiveSegments?.(pipeline.dashboardJobId, buildSubtitleLines(pipeline));
          return;
        }
      }
    });

    const p3 = listen<TranslateSegmentEvent>("translate-segment", (event) => {
      const seg = event.payload;
      for (const [, pipeline] of pipelinesRef.current) {
        if (pipeline.translateJobId === seg.job_id) {
          pipeline.translations.set(seg.index, seg.translated);

          // Checkpoint: every 25 translated segments, persist a snapshot so
          // an app crash/restart loses at most one interval of work.
          // Fire-and-forget — never blocks translation progress.
          if (shouldCheckpoint(pipeline.translations.size)) {
            const snapshot = buildPersistedLines(pipeline);
            // translated_count는 디스크 저장이 성공한 뒤에만 갱신 —
            // "카운트는 디스크에 있는 것 이상을 주장하지 않는다" 불변식 유지.
            saveJobSubtitles(pipeline.dashboardJobId, snapshot)
              .then(() => {
                onJobUpdate(pipeline.dashboardJobId, {
                  translated_count: countTranslated(snapshot),
                });
              })
              .catch(console.error);
          }

          // Record arrival time and re-estimate remaining time
          const times = etaTimesRef.current.get(pipeline.dashboardJobId) ?? [];
          times.push(performance.now());
          const trimmed = times.length > ETA_WINDOW + 1 ? times.slice(-(ETA_WINDOW + 1)) : times;
          etaTimesRef.current.set(pipeline.dashboardJobId, trimmed);
          const remaining = pipeline.segments.length - pipeline.translations.size;
          const etaMs = estimateRemaining(trimmed, remaining);
          const label = etaMs === null ? "" : JSON.stringify(formatEta(etaMs));
          if (etaLabelRef.current.get(pipeline.dashboardJobId) !== label) {
            etaLabelRef.current.set(pipeline.dashboardJobId, label);
            onJobUpdate(pipeline.dashboardJobId, { etaMs });
          }

          // Merged view so a resumed job shows previous translations too
          onLiveSegments?.(pipeline.dashboardJobId, buildPersistedLines(pipeline));
          return;
        }
      }
    });

    const p4 = listen("server-crashed", () => {
      // Fail all active pipelines
      for (const [, pipeline] of pipelinesRef.current) {
        pipeline.phase = "error";
        onJobUpdate(pipeline.dashboardJobId, {
          status: "failed",
          stage: "error",
          error: i18n.t("toast.serverCrashed"),
          etaMs: null,
        });
      }
      pipelinesRef.current.clear();
      etaTimesRef.current.clear();
      etaLabelRef.current.clear();
    });

    Promise.all([p1, p2, p2b, p3, p4]).then((fns) => {
      unlistenersRef.current = fns;
    });

    return () => {
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, [onJobUpdate, onLiveSegments]);

  async function chainDiarization(pipeline: ActivePipeline) {
    if (pipeline.segments.length === 0) {
      if (pipeline.skipTranslation) {
        pipeline.phase = "done";
        finalizePipeline(pipeline);
      } else {
        pipeline.phase = "translating";
        chainTranslation(pipeline);
      }
      return;
    }

    onJobUpdate(pipeline.dashboardJobId, {
      status: "processing",
      stage: "diarizing",
      progress: 40,
    });

    try {
      const diarSegments = pipeline.segments.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        text: s.text,
      }));
      const job = await startDiarization(pipeline.filePath, diarSegments);
      pipeline.diarizationJobId = job.id;
    } catch {
      // Diarization start failed — graceful fallback
      console.warn("Diarization start failed, skipping to next phase");
      if (pipeline.skipTranslation) {
        pipeline.phase = "done";
        finalizePipeline(pipeline);
      } else {
        pipeline.phase = "translating";
        chainTranslation(pipeline);
      }
    }
  }

  const translationStartingRef = useRef(new Set<string>());

  async function chainTranslation(pipeline: ActivePipeline) {
    // Guard: prevent duplicate translation starts
    if (pipeline.translateJobId) return;
    if (translationStartingRef.current.has(pipeline.dashboardJobId)) return;
    translationStartingRef.current.add(pipeline.dashboardJobId);

    if (pipeline.segments.length === 0) {
      // No segments — skip translation
      translationStartingRef.current.delete(pipeline.dashboardJobId);
      pipeline.phase = "done";
      finalizePipeline(pipeline);
      return;
    }

    // No translation LLM installed → can't translate. Save the STT transcript
    // as the final result instead of failing and discarding good STT output.
    try {
      const manifest = await getModelManifest();
      const hasReadyLlm = manifest.models.some(
        (m) => m.model_type === "llm" && m.status === "ready",
      );
      if (!hasReadyLlm) {
        translationStartingRef.current.delete(pipeline.dashboardJobId);
        toastWarning(i18n.t("toast.noLlmSttOnly"));
        pipeline.skipTranslation = true;
        pipeline.phase = "done";
        finalizePipeline(pipeline);
        return;
      }
    } catch (e) {
      // Manifest lookup failed — don't block; let translation attempt proceed.
      console.warn("Could not check installed LLM models:", e);
    }

    // Save intermediate results before starting translation
    // (resume: merged with the previous run's translated lines)
    const initialLines = buildPersistedLines(pipeline);
    try {
      await saveJobSubtitles(pipeline.dashboardJobId, initialLines);
    } catch (e) {
      console.error("Failed to save intermediate STT results:", e);
    }

    onJobUpdate(pipeline.dashboardJobId, {
      status: "processing",
      stage: "translating",
      progress: 0,
      translated_count: countTranslated(initialLines),
    });

    try {
      // Restart server to cleanly free VRAM
      // (ctranslate2 Whisper unload segfaults on Windows — known CTranslate2 bug)
      await restartServer();

      const job = await startTranslate(pipeline.segments, pipeline.presetId);
      pipeline.translateJobId = job.id;
    } catch (e) {
      // Translation start failed — save STT results but mark as failed
      pipeline.phase = "error";
      const errorMsg = e instanceof Error ? e.message : String(e);
      toastError(i18n.t("toast.pipelineFailed"), errorMsg);
      etaTimesRef.current.delete(pipeline.dashboardJobId);
      etaLabelRef.current.delete(pipeline.dashboardJobId);
      onJobUpdate(pipeline.dashboardJobId, {
        status: "failed",
        stage: "translating",
        progress: 0,
        error: errorMsg,
        etaMs: null,
      });
      pipelinesRef.current.delete(pipeline.dashboardJobId);
    } finally {
      translationStartingRef.current.delete(pipeline.dashboardJobId);
    }
  }

  async function finalizePipeline(pipeline: ActivePipeline) {
    const lines = buildPersistedLines(pipeline);

    // Save to disk (internal format)
    try {
      await saveJobSubtitles(pipeline.dashboardJobId, lines);
    } catch (e) {
      console.error("Failed to save subtitles:", e);
      toastError(i18n.t("toast.subtitleSaveFailed"));
    }

    // Auto-export subtitle file to output directory
    try {
      const config = await getConfig();
      const segments: ExportSegmentInput[] = lines.map((line) => ({
        index: line.index,
        start: line.start_time,
        end: line.end_time,
        text: line.original_text,
        translated: line.translated_text || undefined,
      }));
      // Extract filename without extension from source file path
      const baseName = pipeline.filePath
        .split(/[/\\]/).pop()
        ?.replace(/\.[^.]+$/, "") ?? pipeline.dashboardJobId;
      await exportSubtitles(
        segments,
        config.subtitle_format || "srt",
        config.output_dir,
        baseName,
      );
    } catch (e) {
      console.error("Auto-export failed:", e);
      // Non-critical — user can still export manually from editor
    }

    etaTimesRef.current.delete(pipeline.dashboardJobId);
      etaLabelRef.current.delete(pipeline.dashboardJobId);
    onJobUpdate(pipeline.dashboardJobId, {
      status: "completed",
      stage: "done",
      progress: 100,
      etaMs: null,
    });

    pipelinesRef.current.delete(pipeline.dashboardJobId);
  }

  const processJob = useCallback(
    async (dashboardJobId: string, filePath: string, sourceLanguage?: string, enableDiarization?: boolean, skipTranslation?: boolean, presetId?: string, sourceType?: JobSourceType) => {
      const isSubtitleImport = sourceType === "subtitle";
      const pipeline: ActivePipeline = {
        dashboardJobId,
        sttJobId: null,
        diarizationJobId: null,
        translateJobId: null,
        segments: [],
        translations: new Map(),
        speakerMap: new Map(),
        // STT-only options never apply to imported subtitles
        enableDiarization: !isSubtitleImport && (enableDiarization ?? false),
        skipTranslation: !isSubtitleImport && (skipTranslation ?? false),
        presetId,
        filePath,
        phase: isSubtitleImport ? "translating" : "stt",
      };

      pipelinesRef.current.set(dashboardJobId, pipeline);
      etaTimesRef.current.delete(dashboardJobId); // drop stale samples from a previous run
      etaLabelRef.current.delete(dashboardJobId);

      onJobUpdate(dashboardJobId, {
        status: "processing",
        stage: isSubtitleImport ? "translating" : "stt",
        progress: 0,
        etaMs: null,
      });

      try {
        if (isSubtitleImport) {
          // Subtitle file: parse cues and go straight to translation — no STT.
          const imported = await readSubtitleFile(filePath);
          pipeline.segments = imported.map((s) => ({
            index: s.index,
            start: s.start,
            end: s.end,
            text: s.text,
          }));
          const lastSeg = pipeline.segments[pipeline.segments.length - 1];
          if (lastSeg) {
            onJobUpdate(dashboardJobId, { duration: Math.ceil(lastSeg.end) });
          }
          onLiveSegments?.(dashboardJobId, buildSubtitleLines(pipeline));
          chainTranslation(pipeline);
        } else {
          const job = await startStt(filePath, sourceLanguage, undefined, undefined, pipeline.presetId);
          pipeline.sttJobId = job.id;
        }
      } catch (e) {
        pipeline.phase = "error";
        const errorMsg = e instanceof Error ? e.message : String(e);
        toastError(i18n.t("toast.pipelineFailed"), errorMsg);
        onJobUpdate(dashboardJobId, {
          status: "failed",
          stage: "error",
          error: errorMsg,
        });
        pipelinesRef.current.delete(dashboardJobId);
      }
    },
    [onJobUpdate, onLiveSegments],
  );

  const retryTranslation = useCallback(
    async (
      dashboardJobId: string,
      segments: SttSegment[],
      presetId?: string,
      options?: {
        /**
         * Already-translated lines from an interrupted run. `segments` must
         * then contain only the remaining untranslated segments (original
         * indices preserved) — saves merge these base lines back in.
         */
        resumeBaseLines?: SubtitleLine[];
        /** Source file path — used for the auto-export file name. */
        filePath?: string;
      },
    ) => {
      const pipeline: ActivePipeline = {
        dashboardJobId,
        sttJobId: null,
        diarizationJobId: null,
        translateJobId: null,
        segments,
        translations: new Map(),
        speakerMap: new Map(),
        enableDiarization: false,
        skipTranslation: false,
        presetId,
        filePath: options?.filePath ?? "",
        phase: "translating",
        resumeBaseLines: options?.resumeBaseLines,
      };

      pipelinesRef.current.set(dashboardJobId, pipeline);
      etaTimesRef.current.delete(dashboardJobId); // drop stale samples from a previous run
      etaLabelRef.current.delete(dashboardJobId);
      chainTranslation(pipeline);
    },
    [],
  );

  const cancelJob = useCallback(async (dashboardJobId: string) => {
    const pipeline = pipelinesRef.current.get(dashboardJobId);
    if (!pipeline) return;

    try {
      if (pipeline.phase === "stt" && pipeline.sttJobId) {
        await cancelStt(pipeline.sttJobId);
      } else if (pipeline.phase === "diarizing" && pipeline.diarizationJobId) {
        await cancelDiarization(pipeline.diarizationJobId);
      } else if (pipeline.phase === "translating" && pipeline.translateJobId) {
        await cancelTranslate(pipeline.translateJobId);
      }
    } catch (e) {
      console.error("Failed to cancel pipeline:", e);
      toastError(i18n.t("toast.pipelineCancelFailed"));
    }
  }, []);

  return { processJob, retryTranslation, cancelJob };
}
