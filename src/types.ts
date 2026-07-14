export type ServerStatus = "STOPPED" | "STARTING" | "RUNNING" | "ERROR";

export type SetupStatus = "CHECKING" | "NEEDED" | "IN_PROGRESS" | "COMPLETE" | "ERROR";

export type SetupStage = "pip" | "requirements" | "llm" | "complete";

export type SetupErrorKind = "network" | "disk" | "no_wheel" | "integrity" | "unknown";

export interface SetupProgress {
  stage: SetupStage;
  message: string;
  progress: number;
  /** Set on failure: classified pip error kind. */
  error_kind?: SetupErrorKind | null;
}

/** Batched live output of a setup subprocess ("setup-log" event). */
export interface SetupLog {
  stage: SetupStage;
  lines: string[];
}

export type JobState = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELED";

export interface Job {
  id: string;
  input_text: string;
  state: JobState;
  progress: number;
  message: string | null;
  result: string | null;
  error: string | null;
}

// ── Hardware types ──

export interface GpuInfo {
  name: string;
  vram_mb: number;
  cuda_version: string | null;
}

export interface HardwareInfo {
  cpu_name: string;
  cpu_cores: number;
  avx_support: boolean;
  avx2_support: boolean;
  total_ram_gb: number;
  available_ram_gb: number;
  gpu: GpuInfo | null;
}

export interface DiskSpace {
  path: string;
  total_gb: number;
  free_gb: number;
}

// ── Profile types ──

export type Profile = "lite" | "balanced" | "power";

export interface ProfileRecommendation {
  recommended: Profile;
  reason: string;
  gpu_detected: boolean;
  gpu_vram_mb: number | null;
}

// ── Config types ──

export interface ExternalApiConfig {
  provider: string | null;
  api_key: string | null;
  model: string | null;
}

export interface AppConfig {
  version: number;
  wizard_completed: boolean;
  wizard_step: number;
  profile: Profile;
  output_dir: string;
  subtitle_format: string;
  source_language: string;
  target_language: string;
  translation_mode: string;
  context_window: number;
  style_preset: string;
  external_api: ExternalApiConfig;
  model_dir: string | null;
  ui_language: string | null;
  active_whisper_model: string | null;
  active_llm_model: string | null;
  max_concurrent_jobs: number | null;
  gpu_acceleration: boolean | null;
  max_memory_mb: number | null;
  translation_quality: string | null;
  custom_translation_prompt: string | null;
}

export interface PartialConfig {
  wizard_completed?: boolean;
  wizard_step?: number;
  profile?: Profile;
  output_dir?: string;
  subtitle_format?: string;
  source_language?: string;
  target_language?: string;
  translation_mode?: string;
  context_window?: number;
  style_preset?: string;
  external_api?: ExternalApiConfig;
  model_dir?: string | null;
  ui_language?: string | null;
  active_whisper_model?: string | null;
  active_llm_model?: string | null;
  max_concurrent_jobs?: number | null;
  gpu_acceleration?: boolean | null;
  max_memory_mb?: number | null;
  translation_quality?: string | null;
  custom_translation_prompt?: string | null;
}

// ── Model Catalog types ──

export interface WhisperModelEntry {
  id: string;
  name: string;
  repo: string;
  files: string[];
  total_size_bytes: number;
  sha256: Record<string, string>;
  profiles: Profile[];
  license: string;
  license_url: string;
}

export interface LlmSplitFile {
  filename: string;
  sha256: string;
}

export interface LlmModelEntry {
  id: string;
  name: string;
  repo: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  quant: string;
  profiles: Profile[];
  n_gpu_layers_default: number;
  model_category?: string;
  split_files?: LlmSplitFile[];
  license: string;
  license_url: string;
}

export interface ModelCatalog {
  version: number;
  whisper_models: WhisperModelEntry[];
  llm_models: LlmModelEntry[];
}

// ── New Job types ──

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "interrupted";
export type JobStage = "stt" | "diarizing" | "translating" | "done" | "error";
export type Language = "ko" | "en" | "ja" | "zh";

export interface VocabularyEntry {
  id: string;
  source: string;
  target: string;
  /**
   * When true, this entry is consulted ONLY by post-processing
   * (`_fix_untranslated` echo-resolution) and is not injected into
   * the LLM prompt as a few-shot chat turn. Useful for short
   * interjection fallbacks that don't help the model but still need
   * to be caught when it echoes the source.
   */
  fallback_only?: boolean;
}

export interface Vocabulary {
  id: string;
  name: string;
  description: string;
  source_lang: string;
  target_lang: string;
  entries: VocabularyEntry[];
  created_at: string;
  updated_at: string;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  whisper_model: string;
  source_lang: string;
  target_lang: string;
  output_format: string;
  translation_style: string;
  llm_model: string;
  vocabulary_id: string | null;
  is_default?: boolean;
  translation_quality?: string;
  custom_translation_prompt?: string;
  enable_diarization?: boolean;
  media_type?: string;
  /** "direct" (default) | "pivot_2pass" (future: other modes). */
  translation_mode?: string;
  /** Pivot language code ("en" only in v1). Ignored in direct mode. */
  pivot_language?: string;
  /** Vocabulary used for the first leg of pivot 2-pass (source → pivot). */
  pivot_vocabulary_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubtitleLine {
  id: string;
  index: number;
  start_time: number;
  end_time: number;
  original_text: string;
  translated_text: string;
  speaker?: string;
  status: "translated" | "untranslated" | "spell_error" | "editing";
}

export interface DiarizationSegment {
  index: number;
  speaker: string;
}

// ── Dashboard job ──

/** How a job's input file is processed: media runs STT first, subtitle imports cues and goes straight to translation. */
export type JobSourceType = "media" | "subtitle";

export interface DashboardJob {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  duration: number;
  preset_id: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  error?: string;
  created_at: string;
  completed_at?: string;
  /** Optional for backward compatibility — jobs saved before subtitle import existed are media jobs. */
  source_type?: JobSourceType;
  /** Estimated remaining time for the current stage (ms). Transient — not persisted by the Rust backend. */
  etaMs?: number | null;
  /**
   * Number of translated lines persisted by the last checkpoint save.
   * Persisted by the Rust backend — after a restart it tells us the job
   * has partial translations on disk and can be resumed.
   */
  translated_count?: number;
}

// ── Screen navigation ──

export type AppScreen = "BOOT" | "WIZARD" | "SETUP" | "MAIN";
export type MainPage = "dashboard" | "editor" | "presets" | "settings";
export type WizardStep = 1 | 2 | 3 | 4 | 5;
export type SettingsTab =
  | "general"
  | "models"
  | "info";

// ── Download tracking ──

export interface DownloadProgress {
  model_id: string;
  file_name: string;
  file_index: number;
  total_files: number;
  downloaded: number;
  total: number;
  speed_bps: number;
  eta_secs: number;
}

// ── Model manifest ──

export interface ModelManifestEntry {
  id: string;
  model_type: "whisper" | "llm";
  name: string;
  path: string;
  size_bytes: number;
  sha256: string;
  status: "downloading" | "verifying" | "ready" | "missing" | "corrupt";
  installed_at: string;
}

export interface ModelManifest {
  version: number;
  updated_at: string;
  models: ModelManifestEntry[];
}

// ── Runtime ──

export type RuntimeModelStatus = "UNLOADED" | "LOADING" | "READY" | "ERROR";

export interface RuntimeStatus {
  whisper: RuntimeModelStatus;
  llm: RuntimeModelStatus;
}

export interface ResourceUsage {
  ram_used_mb: number;
  ram_total_mb: number;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
}

// ── Pipeline ──

export type PipelinePhase =
  | "idle"
  | "stt"
  | "translating"
  | "done"
  | "error"
  | "cancelled";

export interface SttSegment {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface TranslateSegment {
  index: number;
  original: string;
  translated: string;
}
