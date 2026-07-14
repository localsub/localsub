import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, RefreshCw } from "lucide-react";
import { toastError } from "./lib/toast";
import { useServerStatus } from "./hooks/useServerStatus";
import { useJobs } from "./hooks/useJobs";
import { useSetup } from "./hooks/useSetup";
import { useConfig } from "./hooks/useConfig";
import { useRuntime } from "./hooks/useRuntime";
import { useModels } from "./hooks/useModels";
import { useHardware } from "./hooks/useHardware";
import { usePresets } from "./hooks/usePresets";
import { useVocabularies } from "./hooks/useVocabularies";
import { usePipeline, type JobUpdate } from "./hooks/usePipeline";
import { SetupScreen } from "./components/SetupScreen";
import { WizardScreen } from "./components/wizard/WizardScreen";
import { ThemeProvider } from "./components/theme-provider";
import { AppSidebar } from "./components/app-sidebar";
import { PageHeader } from "./components/page-header";
import { SidebarProvider, SidebarInset } from "./components/ui/sidebar";
import { DashboardPage } from "./components/dashboard/DashboardPage";
import { EditorPage } from "./components/editor/EditorPage";
import { PresetsPage } from "./components/presets/PresetsPage";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Toaster } from "./components/ui/sonner";
import { Button } from "./components/ui/button";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { AppScreen, MainPage, DashboardJob, SubtitleLine, JobSourceType } from "./types";
import { loadDashboardJobs, saveDashboardJobs, loadJobSubtitles } from "./lib/tauriApi";
import { getSourceType } from "./lib/sourceType";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

function determineScreen(
  configLoading: boolean,
  config: { wizard_completed: boolean } | null,
  setupStatus: string,
): AppScreen {
  if (configLoading || setupStatus === "CHECKING") return "BOOT";
  if (!config || !config.wizard_completed) return "WIZARD";
  if (setupStatus !== "COMPLETE") return "SETUP";
  return "MAIN";
}

const PAGE_TITLES = {
  dashboard: { titleKey: "nav.dashboard" as const, descKey: "dashboard.description" as const },
  editor: { titleKey: "nav.editor" as const, descKey: "editor.description" as const },
  presets: { titleKey: "nav.presets" as const, descKey: "presets.description" as const },
  settings: { titleKey: "nav.settings" as const, descKey: "settings.description" as const },
} satisfies Record<MainPage, { titleKey: string; descKey?: string }>;

interface QueueEntry {
  jobId: string;
  filePath: string;
  sourceLanguage?: string;
  enableDiarization: boolean;
  skipTranslation: boolean;
  presetId?: string;
  sourceType: JobSourceType;
}

function App() {
  const { t } = useTranslation();
  const { config, loading: configLoading, error: configError, update: updateConfig, reload: reloadConfig } = useConfig();
  const { status: setupStatus, progress, error: setupError, logLines: setupLogLines, startSetup, retry, reset: resetSetup } = useSetup();
  const serverHook = useServerStatus();

  // Auto-start the Python server once setup is complete.
  //
  // Keyed on setupStatus (not just mount): on a normal launch checkSetup flips
  // it CHECKING→COMPLETE and we start; on a fresh first-run the user clicks
  // through setup and it flips IN_PROGRESS→COMPLETE here. A plain mount-only
  // effect started too early — start_server is gated until the setup marker
  // exists — and never retried, leaving the server down until an app restart.
  useEffect(() => {
    if (setupStatus === "COMPLETE" && serverHook.status === "STOPPED") {
      serverHook.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupStatus, serverHook.status]);
  useJobs(); // keep listener active
  useRuntime(); // keep polling active
  const models = useModels();
  const { hardware, detect: detectHw } = useHardware();
  const presetsHook = usePresets();
  const vocabulariesHook = useVocabularies();

  const [activePage, setActivePage] = useState<MainPage>("dashboard");
  const [dashboardJobs, setDashboardJobs] = useState<DashboardJob[]>([]);
  const [editorJobId, setEditorJobId] = useState<string | null>(null);
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  const [liveLines, setLiveLines] = useState<Map<string, SubtitleLine[]>>(new Map());

  // ── Job queue ──
  const queueRef = useRef<QueueEntry[]>([]);
  const activeCountRef = useRef(0);
  // 이어서 번역 중복 진입 가드 (잡 상태 갱신 전 비동기 구간 보호)
  const resumeInFlightRef = useRef<Set<string>>(new Set());
  const drainQueueRef = useRef(() => {});
  // handleJobUpdate는 deps가 비어 있어 dashboardJobs를 클로저로 잡으면 초기값(빈 배열)만 봄.
  // 완료 알림에서 파일명을 얻으려면 최신 잡 목록을 ref로 참조한다.
  const dashboardJobsRef = useRef<DashboardJob[]>([]);

  const handleJobUpdate = useCallback(
    (jobId: string, update: JobUpdate) => {
      setDashboardJobs((prev) =>
        prev.map((j) => {
          if (j.id !== jobId) return j;
          const patched = { ...j, ...update };
          // Set completed_at when job finishes or fails
          if ((update.status === "completed" || update.status === "failed") && !j.completed_at) {
            patched.completed_at = new Date().toISOString();
          }
          // 체크포인트 카운트는 재개 판단 전용 — 완료된 잡에 남기지 않는다
          if (update.status === "completed") {
            patched.translated_count = undefined;
          }
          return patched;
        }),
      );
      // Send desktop notification when pipeline finishes
      if (update.status === "completed" || update.status === "failed") {
        const finishedJob = dashboardJobsRef.current.find((j) => j.id === jobId);
        const fileName = finishedJob?.file_name ?? jobId;
        isPermissionGranted().then(async (granted) => {
          if (!granted) {
            const result = await requestPermission();
            granted = result === "granted";
          }
          if (granted) {
            sendNotification({
              title: update.status === "completed"
                ? t("notification.completed", { name: fileName })
                : t("notification.failed", { name: fileName }),
              body: update.status === "completed"
                ? t("notification.completedBody")
                : (update.error ?? t("notification.failedBody")),
            });
          }
        }).catch(() => { /* notification not critical */ });
      }
      // Clear liveLines and drain queue when pipeline finishes
      if (update.status === "completed" || update.status === "failed") {
        setLiveLines((prev) => {
          if (!prev.has(jobId)) return prev;
          const next = new Map(prev);
          next.delete(jobId);
          return next;
        });
        activeCountRef.current = Math.max(0, activeCountRef.current - 1);
        // Use setTimeout to ensure drainQueue runs after state updates
        setTimeout(() => drainQueueRef.current(), 0);
      }
    },
    [],
  );

  const handleLiveSegments = useCallback((jobId: string, lines: SubtitleLine[]) => {
    setLiveLines((prev) => {
      const next = new Map(prev);
      next.set(jobId, lines);
      return next;
    });
  }, []);

  const { processJob, retryTranslation } = usePipeline(handleJobUpdate, handleLiveSegments);

  const drainQueue = useCallback(() => {
    // GPU pipeline must run one at a time (VRAM shared between STT and LLM)
    while (queueRef.current.length > 0 && activeCountRef.current < 1) {
      const entry = queueRef.current.shift()!;
      activeCountRef.current++;
      processJob(entry.jobId, entry.filePath, entry.sourceLanguage, entry.enableDiarization, entry.skipTranslation, entry.presetId, entry.sourceType);
    }
  }, [processJob]);
  drainQueueRef.current = drainQueue;

  const screen = determineScreen(configLoading, config, setupStatus);

  // Auto-detect hardware when entering main screen
  useEffect(() => {
    if (screen === "MAIN" && !hardware) {
      detectHw();
    }
  }, [screen, hardware, detectHw]);

  // Lazy-load model catalog when entering settings
  useEffect(() => {
    if (activePage === "settings" && !models.catalog) {
      models.loadCatalog();
    }
  }, [activePage, models.catalog, models.loadCatalog]);

  // Load persisted jobs when entering main screen
  const [jobsLoaded, setJobsLoaded] = useState(false);
  useEffect(() => {
    if (screen === "MAIN" && !jobsLoaded) {
      loadDashboardJobs()
        .then((saved) => {
          if (saved.length > 0) {
            // Recover stuck jobs: no pipeline survives a restart, so
            // processing jobs with checkpointed translations become
            // "interrupted" (resumable), the rest become failed.
            const recovered = saved.map((j) => {
              if (j.status !== "processing") return j;
              if ((j.translated_count ?? 0) > 0) {
                return { ...j, status: "interrupted" as const, error: undefined, etaMs: null };
              }
              return { ...j, status: "failed" as const, error: "Interrupted by app restart" };
            });
            setDashboardJobs(recovered);
          }
          setJobsLoaded(true);
        })
        .catch((e) => {
          console.error("Failed to load dashboard jobs:", e);
          toastError(t("toast.jobsLoadFailed"));
          setJobsLoaded(true);
        });
    }
  }, [screen, jobsLoaded]);

  // Keep the ref in sync so event callbacks (handleJobUpdate) see the latest jobs
  useEffect(() => {
    dashboardJobsRef.current = dashboardJobs;
  }, [dashboardJobs]);

  // Persist jobs to disk whenever they change (after initial load)
  useEffect(() => {
    if (!jobsLoaded) return;
    saveDashboardJobs(dashboardJobs).catch((e) => {
      console.error("Failed to save dashboard jobs:", e);
      toastError(t("toast.jobsSaveFailed"));
    });
  }, [dashboardJobs, jobsLoaded]);

  const handleWizardComplete = useCallback(() => {
    reloadConfig();
  }, [reloadConfig]);

  const handleNewJob = useCallback(
    (files: { name: string; path: string; size: number }[], presetId: string, enableDiarization: boolean = false, skipTranslation: boolean = false) => {
      const newJobs: DashboardJob[] = files.map((f) => {
        const sourceType = getSourceType(f.path);
        return {
          id: crypto.randomUUID(),
          file_name: f.name,
          file_path: f.path,
          file_size: f.size,
          duration: 0,
          preset_id: presetId,
          status: "pending" as const,
          // Subtitle imports skip STT — they enter the pipeline at translation
          stage: sourceType === "subtitle" ? ("translating" as const) : ("stt" as const),
          progress: 0,
          created_at: new Date().toISOString(),
          source_type: sourceType,
        };
      });
      setDashboardJobs((prev) => [...newJobs, ...prev]);

      // Auto-navigate to editor for the first job
      const first = newJobs[0];
      if (first) {
        setEditorJobId(first.id);
        setEditorFilePath(first.file_path);
        setActivePage("editor");
      }

      // Enqueue jobs and drain up to concurrency limit
      const sourceLanguage = config?.source_language;
      for (const job of newJobs) {
        queueRef.current.push({
          jobId: job.id,
          filePath: job.file_path,
          sourceLanguage: sourceLanguage === "auto" ? undefined : sourceLanguage,
          enableDiarization,
          skipTranslation,
          presetId,
          sourceType: job.source_type ?? "media",
        });
      }
      drainQueue();
    },
    [drainQueue, config?.source_language],
  );

  const handleRemoveJob = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((e) => e.jobId !== id);
    setDashboardJobs((prev) => {
      const job = prev.find((j) => j.id === id);
      if (job && job.status === "processing") {
        activeCountRef.current = Math.max(0, activeCountRef.current - 1);
        setTimeout(() => drainQueueRef.current(), 0);
      }
      return prev.filter((j) => j.id !== id);
    });
  }, []);

  const handleRetryJob = useCallback(
    async (jobId: string) => {
      const job = dashboardJobs.find((j) => j.id === jobId);
      if (!job) return;

      // Try to load existing subtitles — if they have original_text, skip STT
      try {
        const existing = await loadJobSubtitles(jobId);
        if (existing.length > 0 && existing[0].original_text) {
          // Has STT results — retry translation only
          activeCountRef.current++;
          setDashboardJobs((prev) =>
            prev.map((j) =>
              j.id === jobId
                ? { ...j, status: "processing" as const, stage: "translating" as const, progress: 50, error: undefined, completed_at: undefined }
                : j,
            ),
          );
          const segments = existing.map((l) => ({
            index: l.index,
            start: l.start_time,
            end: l.end_time,
            text: l.original_text,
          }));
          // Pass the job's preset_id so the retry picks up the current
          // preset on disk — lets users change translation_mode
          // (e.g. direct → pivot_2pass) and re-run translation without
          // redoing STT.
          retryTranslation(jobId, segments, job.preset_id, { filePath: job.file_path });
          return;
        }
      } catch {
        // No existing subtitles — full retry
      }

      // Full retry — subtitle jobs re-import the file (never re-run STT)
      const sourceType = job.source_type ?? "media";
      setDashboardJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: "pending" as const, stage: sourceType === "subtitle" ? ("translating" as const) : ("stt" as const), progress: 0, error: undefined, completed_at: undefined }
            : j,
        ),
      );
      const sourceLanguage = config?.source_language;
      queueRef.current.push({
        jobId: job.id,
        filePath: job.file_path,
        sourceLanguage: sourceLanguage === "auto" ? undefined : sourceLanguage,
        enableDiarization: false,
        skipTranslation: false,
        presetId: job.preset_id,
        sourceType,
      });
      drainQueue();
    },
    [dashboardJobs, drainQueue, retryTranslation, config?.source_language],
  );

  // Resume an interrupted job: re-feed only the untranslated lines and keep
  // the checkpointed translations as the merge base — never re-translates
  // (or destroys) what previous runs already finished.
  const handleResumeJob = useCallback(
    async (jobId: string) => {
      const job = dashboardJobs.find((j) => j.id === jobId);
      // interrupted 전용 + 중복 클릭 가드: 두 번 진입하면 activeCount가 새고
      // 파이프라인이 덮어써져 큐 전체가 멈춘다.
      if (!job || job.status !== "interrupted") return;
      if (resumeInFlightRef.current.has(jobId)) return;
      resumeInFlightRef.current.add(jobId);

      let existing: SubtitleLine[];
      try {
        existing = await loadJobSubtitles(jobId);
      } catch (e) {
        console.error("Failed to load checkpoint for resume:", e);
        toastError(t("toast.resumeFailed"));
        resumeInFlightRef.current.delete(jobId);
        return;
      }
      if (existing.length === 0) {
        // No checkpoint on disk — fall back to the regular retry path
        resumeInFlightRef.current.delete(jobId);
        handleRetryJob(jobId);
        return;
      }

      // GPU 파이프라인은 동시 1개 — 다른 잡 실행 중 재개하면 chainTranslation의
      // restartServer()가 그 잡의 서버 작업을 죽인다. 끝난 뒤 재개하도록 안내.
      if (activeCountRef.current >= 1) {
        toastError(t("toast.resumeBusy"));
        resumeInFlightRef.current.delete(jobId);
        return;
      }

      const isTranslated = (l: SubtitleLine) =>
        l.status === "translated" && l.translated_text.trim() !== "";
      const baseLines = existing.filter(isTranslated);
      const remaining = existing.filter((l) => !isTranslated(l));

      activeCountRef.current++;
      setDashboardJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: "processing" as const, stage: "translating" as const, progress: 0, error: undefined, completed_at: undefined }
            : j,
        ),
      );
      const segments = remaining.map((l) => ({
        index: l.index,
        start: l.start_time,
        end: l.end_time,
        text: l.original_text,
      }));
      retryTranslation(jobId, segments, job.preset_id, {
        resumeBaseLines: baseLines,
        filePath: job.file_path,
      });
      // 파이프라인에 인계 완료 — 잡 상태가 processing이 되어 재진입은 status 가드가 막는다.
      resumeInFlightRef.current.delete(jobId);
    },
    [dashboardJobs, retryTranslation, handleRetryJob, t],
  );

  // ── Config error screen ──
  if (configError && !configLoading && !config) {
    return (
      <ThemeProvider defaultTheme="dark">
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <div className="rounded-2xl bg-destructive/10 p-4 ring-1 ring-destructive/30">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <div>
              <p className="font-semibold text-lg">{t("configError.title")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("configError.description")}</p>
              <p className="text-xs text-destructive mt-2 font-mono break-all">{configError}</p>
            </div>
            <Button onClick={reloadConfig} variant="outline" size="sm">
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("configError.retry")}
            </Button>
          </div>
        </div>
        <Toaster />
      </ThemeProvider>
    );
  }

  // ── BOOT: Loading spinner ──
  if (screen === "BOOT") {
    return (
      <ThemeProvider defaultTheme="dark">
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-2.5 text-muted-foreground">
            <span className="spinner" />
            <span>{t("app.loading")}</span>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  // ── WIZARD ──
  if (screen === "WIZARD") {
    return (
      <ThemeProvider defaultTheme="dark">
        <WizardScreen
          config={config!}
          onUpdateConfig={updateConfig}
          onComplete={handleWizardComplete}
        />
      </ThemeProvider>
    );
  }

  // ── SETUP (fallback for pip install) ──
  if (screen === "SETUP") {
    return (
      <ThemeProvider defaultTheme="dark">
        <SetupScreen
          status={setupStatus}
          progress={progress}
          error={setupError}
          logLines={setupLogLines}
          onStart={startSetup}
          onRetry={retry}
          onReset={resetSetup}
        />
      </ThemeProvider>
    );
  }

  // ── MAIN: Sidebar + page content ──
  const pageInfo = PAGE_TITLES[activePage];

  return (
    <ThemeProvider defaultTheme="dark">
      <ErrorBoundary>
        <SidebarProvider>
          <AppSidebar
            activePage={activePage}
            onNavigate={setActivePage}
            hardwareInfo={hardware}
            serverStatus={serverHook.status}
            onRestartServer={serverHook.start}
          />
          <SidebarInset>
            <PageHeader
              title={t(pageInfo.titleKey)}
              description={pageInfo.descKey ? t(pageInfo.descKey) : undefined}
            />
            <div className="flex flex-1 flex-col overflow-auto p-4">
              {activePage === "dashboard" && (
                <DashboardPage
                  jobs={dashboardJobs}
                  presets={presetsHook.presets}
                  vocabularies={vocabulariesHook.vocabularies}
                  onNewJob={handleNewJob}
                  onRemoveJob={handleRemoveJob}
                  onRetryJob={handleRetryJob}
                  onResumeJob={handleResumeJob}
                  onUpdateVocabulary={vocabulariesHook.update}
                  onAddVocabulary={vocabulariesHook.add}
                  onUpdatePreset={presetsHook.update}
                  onOpenEditor={(jobId, filePath) => {
                    setEditorJobId(jobId);
                    setEditorFilePath(filePath);
                    setActivePage("editor");
                  }}
                />
              )}

              {activePage === "editor" && config && (
                <EditorPage
                  jobId={editorJobId}
                  filePath={editorFilePath}
                  outputDir={config.output_dir}
                  subtitleFormat={config.subtitle_format}
                  presetId={dashboardJobs.find((j) => j.id === editorJobId)?.preset_id}
                  vocabularies={vocabulariesHook.vocabularies}
                  onUpdateVocabulary={vocabulariesHook.update}
                  liveLines={editorJobId ? liveLines.get(editorJobId) : undefined}
                />
              )}

              {activePage === "presets" && (
                <PresetsPage
                  presets={presetsHook.presets}
                  vocabularies={vocabulariesHook.vocabularies}
                  manifest={models.manifest}
                  onAddPreset={presetsHook.add}
                  onUpdatePreset={presetsHook.update}
                  onRemovePreset={presetsHook.remove}
                  onAddVocabulary={vocabulariesHook.add}
                  onUpdateVocabulary={vocabulariesHook.update}
                  onRemoveVocabulary={vocabulariesHook.remove}
                />
              )}

              {activePage === "settings" && config && (
                <SettingsPage
                  config={config}
                  manifest={models.manifest}
                  catalog={models.catalog}
                  hardware={hardware}
                  downloads={models.downloads}
                  onUpdateConfig={(patch) => updateConfig(patch)}
                  onDeleteModel={models.deleteModel}
                  onDownloadModel={models.startDownload}
                  onCancelDownload={models.cancelDownload}
                />
              )}
            </div>
          </SidebarInset>
        </SidebarProvider>
      </ErrorBoundary>
      <Toaster />
    </ThemeProvider>
  );
}

export default App;
