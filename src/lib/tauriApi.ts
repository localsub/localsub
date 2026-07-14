import { invoke } from "@tauri-apps/api/core";
import type {
  Job,
  ServerStatus,
  SetupStatus,
  HardwareInfo,
  ProfileRecommendation,
  DiskSpace,
  AppConfig,
  PartialConfig,
  ModelCatalog,
  ModelManifest,
  SttSegment,
  RuntimeStatus,
  Preset,
  Vocabulary,
  SubtitleLine,
  DashboardJob,
} from "../types";

export async function startServer(): Promise<void> {
  await invoke("start_server");
}

export async function stopServer(): Promise<void> {
  await invoke("stop_server");
}

export async function restartServer(): Promise<void> {
  await invoke("restart_server");
}

export async function getServerStatus(): Promise<ServerStatus> {
  return invoke<ServerStatus>("get_server_status");
}

export async function getJobs(): Promise<Job[]> {
  return invoke<Job[]>("get_jobs");
}

export async function checkSetup(): Promise<SetupStatus> {
  return invoke<SetupStatus>("check_setup");
}

export async function runSetup(): Promise<void> {
  await invoke("run_setup");
}

export async function resetSetup(): Promise<void> {
  await invoke("reset_setup");
}

// ── Wizard commands ──

export async function detectHardware(): Promise<HardwareInfo> {
  return invoke<HardwareInfo>("detect_hardware");
}

export async function recommendProfile(
  hw: HardwareInfo,
): Promise<ProfileRecommendation> {
  return invoke<ProfileRecommendation>("recommend_profile", { hw });
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  return invoke<ModelCatalog>("get_model_catalog");
}

export async function checkDiskSpace(path: string): Promise<DiskSpace> {
  return invoke<DiskSpace>("check_disk_space", { path });
}

// ── Config commands ──

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export async function updateConfig(
  partial: PartialConfig,
): Promise<AppConfig> {
  return invoke<AppConfig>("update_config", { partial });
}

// ── Model commands ──

export async function downloadModel(modelId: string): Promise<void> {
  await invoke("download_model", { modelId });
}

export async function cancelDownload(modelId: string): Promise<void> {
  await invoke("cancel_download", { modelId });
}

export async function deleteModel(modelId: string): Promise<void> {
  await invoke("delete_model", { modelId });
}

export async function getModelManifest(): Promise<ModelManifest> {
  return invoke<ModelManifest>("get_model_manifest");
}

export async function verifyModel(modelId: string): Promise<string> {
  return invoke<string>("verify_model", { modelId });
}

// ── STT commands ──

export async function startStt(
  filePath: string,
  language?: string,
  startTime?: number,
  endTime?: number,
  presetId?: string,
): Promise<Job> {
  return invoke<Job>("start_stt", { filePath, language, startTime, endTime, presetId });
}

export async function cancelStt(jobId: string): Promise<void> {
  await invoke("cancel_stt", { jobId });
}

// ── Diarization commands ──

export interface DiarSegmentInput {
  index: number;
  start: number;
  end: number;
  text: string;
}

export async function startDiarization(
  filePath: string,
  segments: DiarSegmentInput[],
): Promise<Job> {
  return invoke<Job>("start_diarization", { filePath, segments });
}

export async function cancelDiarization(jobId: string): Promise<void> {
  await invoke("cancel_diarization", { jobId });
}

// ── Translate commands ──

export async function startTranslate(
  segments: SttSegment[],
  presetId?: string,
): Promise<Job> {
  return invoke<Job>("start_translate", { segments, presetId });
}

export async function cancelTranslate(jobId: string): Promise<void> {
  await invoke("cancel_translate", { jobId });
}

// ── Export commands ──

export interface ExportSegmentInput {
  index: number;
  start: number;
  end: number;
  text: string;
  translated?: string;
}

export async function exportSubtitles(
  segments: ExportSegmentInput[],
  format: string,
  outputDir: string,
  fileName: string,
): Promise<string> {
  return invoke<string>("export_subtitles", {
    segments,
    format,
    outputDir,
    fileName,
  });
}

export async function openFolder(path: string): Promise<void> {
  await invoke("open_folder", { path });
}

// ── Runtime commands ──

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("get_runtime_status");
}

export async function loadRuntimeModel(
  modelType: string,
  modelId: string,
): Promise<void> {
  await invoke("load_runtime_model", { modelType, modelId });
}

export async function unloadRuntimeModel(modelType: string): Promise<void> {
  await invoke("unload_runtime_model", { modelType });
}

// ── Dialog helpers ──

import { open } from "@tauri-apps/plugin-dialog";

export async function pickDirectory(): Promise<string | null> {
  try {
    const result = await open({ directory: true, multiple: false });
    if (Array.isArray(result)) return result[0] ?? null;
    return result;
  } catch {
    return null;
  }
}

export async function pickFile(
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> {
  try {
    const result = await open({ filters, multiple: false });
    if (Array.isArray(result)) return result[0] ?? null;
    return result;
  } catch {
    return null;
  }
}

// ── Preset commands ──

export async function getPresets(): Promise<Preset[]> {
  return invoke("get_presets");
}

export async function addPreset(preset: Preset): Promise<Preset[]> {
  return invoke("add_preset", { preset });
}

export async function updatePreset(preset: Preset): Promise<Preset[]> {
  return invoke("update_preset", { preset });
}

export async function removePreset(id: string): Promise<Preset[]> {
  return invoke("remove_preset", { id });
}

// ── ffmpeg commands ──

export async function checkFfmpeg(): Promise<boolean> {
  return invoke<boolean>("check_ffmpeg");
}

export async function getFfmpegPath(): Promise<string> {
  return invoke<string>("get_ffmpeg_path");
}

export async function downloadFfmpeg(): Promise<string> {
  return invoke<string>("download_ffmpeg");
}

// ── Vocabulary commands ──

export async function getVocabularies(): Promise<Vocabulary[]> {
  return invoke("get_vocabularies");
}

export async function addVocabulary(vocabulary: Vocabulary): Promise<Vocabulary[]> {
  return invoke("add_vocabulary", { vocabulary });
}

export async function updateVocabulary(vocabulary: Vocabulary): Promise<Vocabulary[]> {
  return invoke("update_vocabulary", { vocabulary });
}

export async function removeVocabulary(id: string): Promise<Vocabulary[]> {
  return invoke("remove_vocabulary", { id });
}

// ── CSV commands ──

export interface CsvRow {
  source: string;
  target: string;
  context: string | null;
  note: string | null;
}

export async function readCsvFile(path: string): Promise<CsvRow[]> {
  return invoke<CsvRow[]>("read_csv_file", { path });
}

// ── Subtitle import commands ──

/** Segment parsed from an imported .srt/.vtt file (Rust SubtitleSegment). */
export interface ImportedSubtitleSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  translated: string | null;
  speaker: string | null;
}

export async function readSubtitleFile(
  path: string,
): Promise<ImportedSubtitleSegment[]> {
  return invoke<ImportedSubtitleSegment[]>("read_subtitle_file", { path });
}

// ── Dashboard job commands ──

export async function loadDashboardJobs(): Promise<DashboardJob[]> {
  return invoke("load_dashboard_jobs");
}

export async function saveDashboardJobs(jobs: DashboardJob[]): Promise<void> {
  await invoke("save_dashboard_jobs", { jobs });
}

// ── Subtitle commands ──

export async function loadJobSubtitles(jobId: string): Promise<SubtitleLine[]> {
  return invoke("load_job_subtitles", { jobId });
}

export async function saveJobSubtitles(jobId: string, lines: SubtitleLine[]): Promise<void> {
  return invoke("save_job_subtitles", { jobId, lines });
}
