import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";

/**
 * The GPU runs one job at a time: every translation start calls
 * restart_server to reclaim VRAM, which kills whatever job the server is
 * running. Retry must therefore wait its turn in the queue like any other job
 * — never start a translation beside a running one — and a job that is already
 * running must not be retried on top of itself.
 *
 * Drives the real <App/> against a scripted IPC backend: two failed jobs that
 * already hold STT output, so Retry takes the translation-only path.
 */

const ipc = vi.hoisted(() => {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  let translateN = 0;
  const iso = new Date().toISOString();
  const job = (id: string, name: string, status: string) => ({
    id, file_name: name, file_path: `D:/${name}`, file_size: 1, duration: 60,
    preset_id: "preset-1", status, stage: "error", progress: 50, created_at: iso,
  });
  const state = {
    calls,
    listeners,
    reset() {
      calls.length = 0;
      listeners.clear();
      translateN = 0;
    },
    count(cmd: string) {
      return calls.filter((c) => c.cmd === cmd).length;
    },
    emit(event: string, payload: unknown) {
      for (const h of listeners.get(event) ?? []) h({ payload });
    },
    dispatch(cmd: string, args: Record<string, unknown> = {}): unknown {
      calls.push({ cmd, args });
      switch (cmd) {
        case "get_config": case "update_config":
          return {
            version: 1, wizard_completed: true, wizard_step: 5, profile: "power",
            output_dir: "C:/out", subtitle_format: "srt", source_language: "ja", target_language: "ko",
            translation_mode: "direct", context_window: 4, style_preset: "natural",
            external_api: { provider: null, api_key: null, model: null }, model_dir: "C:/models",
            ui_language: "en", active_whisper_model: "w", active_llm_model: "q",
            max_concurrent_jobs: 1, gpu_acceleration: true, max_memory_mb: null,
            translation_quality: "balanced", custom_translation_prompt: null, two_pass_translation: false,
          };
        case "check_setup": return "COMPLETE";
        case "get_server_status": return "RUNNING";
        case "get_runtime_status": return { whisper: "READY", llm: "READY" };
        case "get_vcredist_state": return { status: { missing: [], core_blocked: false }, last_attempt: null };
        case "load_dashboard_jobs":
          return [job("job-B", "B_episode.mkv", "failed"), job("job-C", "C_episode.mkv", "failed")];
        case "load_job_subtitles":
          return [0, 1].map((i) => ({
            id: `${args.jobId}-${i}`, index: i + 1, start_time: i * 2, end_time: i * 2 + 1.5,
            original_text: `line ${i}`, translated_text: "", status: "untranslated",
          }));
        case "get_presets":
          return [{ id: "preset-1", name: "P", description: "", whisper_model: "w", source_lang: "ja",
            target_lang: "ko", output_format: "srt", translation_style: "natural", llm_model: "q",
            vocabulary_id: null, is_default: true, translation_quality: "balanced",
            enable_diarization: false, media_type: "movie", translation_mode: "direct",
            created_at: iso, updated_at: iso }];
        case "get_vocabularies": case "get_jobs": return [];
        case "get_model_manifest":
          return { version: 1, updated_at: iso, models: [
            { id: "q", model_type: "llm", name: "Q", path: "m/q", size_bytes: 1, sha256: "y",
              status: "ready", installed_at: iso }] };
        case "start_translate":
          translateN += 1;
          return { id: `tr-${translateN}`, state: "RUNNING", progress: 0, message: "" };
        default: return null;
      }
    },
  };
  return state;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    try {
      return Promise.resolve(ipc.dispatch(cmd, args));
    } catch (e) {
      return Promise.reject(e);
    }
  },
  convertFileSrc: (p: string) => p,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    if (!ipc.listeners.has(event)) ipc.listeners.set(event, new Set());
    ipc.listeners.get(event)!.add(handler);
    return () => ipc.listeners.get(event)?.delete(handler);
  },
  emit: async () => {},
}));

import i18n from "@/i18n";
import App from "@/App";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // The dashboard's native drag-drop listener goes through @tauri-apps/api's
  // own internals (not the aliased modules above); give it a no-op backend.
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: () => Promise.resolve(0),
      transformCallback: () => 0,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => Promise.resolve() },
  });
});

beforeEach(() => ipc.reset());

/** Let the pipeline's async IPC chain run to a resting point. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function openActions(fileName: string) {
  const row = screen.getByText(fileName).closest("tr")!;
  const trigger = within(row).getByRole("button", { name: "Job actions" });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

async function retry(fileName: string) {
  openActions(fileName);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Retry" }));
  await settle();
}

describe("Retry and the one-job-at-a-time GPU queue", () => {
  it("queues a retry behind the running job instead of restarting the server under it", async () => {
    render(<App />);
    await screen.findByText("C_episode.mkv");

    await retry("B_episode.mkv");
    expect(ipc.count("restart_server")).toBe(1);
    expect(ipc.count("start_translate")).toBe(1);

    await retry("C_episode.mkv");
    // B is still translating: C must wait, not restart the server beneath B.
    expect(ipc.count("restart_server")).toBe(1);
    expect(ipc.count("start_translate")).toBe(1);

    // B finishes -> the queue hands the GPU to C.
    await act(async () => {
      ipc.emit("job-updated", { id: "tr-1", state: "DONE", progress: 100, message: "" });
    });
    await settle();
    expect(ipc.count("restart_server")).toBe(2);
    expect(ipc.count("start_translate")).toBe(2);
  });

  it("queues a job once even when Retry is hit again while its subtitles load", async () => {
    render(<App />);
    await screen.findByText("C_episode.mkv");
    await retry("B_episode.mkv");

    // Second click lands before the first one's load_job_subtitles resolves.
    openActions("C_episode.mkv");
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    openActions("C_episode.mkv");
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    await settle();

    for (const id of ["tr-1", "tr-2"]) {
      await act(async () => {
        ipc.emit("job-updated", { id, state: "DONE", progress: 100, message: "" });
      });
      await settle();
    }
    // B once, then C once — not C a second time.
    expect(ipc.count("start_translate")).toBe(2);
  });

  it("does not offer Retry on a job that is already running", async () => {
    render(<App />);
    await screen.findByText("C_episode.mkv");

    await retry("B_episode.mkv");
    openActions("B_episode.mkv");
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Retry" })).toBeNull();
  });
});
