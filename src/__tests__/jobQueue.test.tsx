import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";

/**
 * The GPU runs one job at a time: every translation start calls
 * restart_server to reclaim VRAM, which kills whatever job the server is
 * running. Retry must therefore wait its turn in the queue like any other job
 * — never start a translation beside a running one — and a job that is already
 * running must not be retried on top of itself. Removing a running job must
 * stop its pipeline before its slot goes to the next job.
 *
 * Drives the real <App/> against a scripted IPC backend. B, C and E are failed
 * jobs that already hold STT output, so Retry takes the translation-only path;
 * F has none, so its Retry goes through STT.
 */

const ipc = vi.hoisted(() => {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  let translateN = 0;
  let sttN = 0;
  const held = new Set<string>();
  const waiting = new Map<string, () => void>();
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
      sttN = 0;
      held.clear();
      waiting.clear();
    },
    count(cmd: string) {
      return calls.filter((c) => c.cmd === cmd).length;
    },
    argsOf(cmd: string) {
      return calls.filter((c) => c.cmd === cmd).map((c) => c.args);
    },
    /** The next call to `cmd` stays pending until `release(cmd)`. */
    hold(cmd: string) {
      held.add(cmd);
    },
    release(cmd: string) {
      const go = waiting.get(cmd);
      waiting.delete(cmd);
      go?.();
    },
    respond(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      const result = state.dispatch(cmd, args);
      if (!held.delete(cmd)) return Promise.resolve(result);
      return new Promise((r) => waiting.set(cmd, () => r(result)));
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
          return [
            job("job-B", "B_episode.mkv", "failed"), job("job-C", "C_episode.mkv", "failed"),
            job("job-E", "E_episode.mkv", "failed"), job("job-F", "F_episode.mkv", "failed"),
          ];
        case "load_job_subtitles":
          if (args.jobId === "job-F") return [];
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
        case "start_stt":
          sttN += 1;
          return { id: `stt-${sttN}`, state: "RUNNING", progress: 0, message: "" };
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
      return ipc.respond(cmd, args);
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

async function remove(fileName: string) {
  openActions(fileName);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await settle();
}

async function finishTranslation(id: string) {
  await act(async () => {
    ipc.emit("job-updated", { id, state: "DONE", progress: 100, message: "" });
  });
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

describe("Removing a running job", () => {
  it("cancels its pipeline and hands its slot to the next job exactly once", async () => {
    render(<App />);
    await screen.findByText("E_episode.mkv");
    await retry("B_episode.mkv"); // running: tr-1
    await retry("C_episode.mkv"); // queued
    await retry("E_episode.mkv"); // queued

    await remove("B_episode.mkv");
    expect(ipc.argsOf("cancel_translate")).toEqual([{ jobId: "tr-1" }]);
    // C takes the GPU; E keeps waiting.
    expect(ipc.count("restart_server")).toBe(2);
    expect(ipc.count("start_translate")).toBe(2);

    // B's server job finishes after all (the cancel landed too late). Nothing
    // may act on it: no export for a removed job, no slot freed a second time.
    await finishTranslation("tr-1");
    expect(ipc.count("export_subtitles")).toBe(0);
    expect(ipc.count("restart_server")).toBe(2);
    expect(ipc.count("start_translate")).toBe(2);

    // C finishes -> E runs.
    await finishTranslation("tr-2");
    expect(ipc.count("start_translate")).toBe(3);
  });

  it("never restarts the server for a job removed before its translation started", async () => {
    render(<App />);
    await screen.findByText("C_episode.mkv");
    ipc.hold("save_job_subtitles"); // B's chain parks just before its restart
    await retry("B_episode.mkv");
    await retry("C_episode.mkv");
    expect(ipc.count("restart_server")).toBe(0);

    await remove("B_episode.mkv");
    expect(ipc.count("restart_server")).toBe(1); // C's
    expect(ipc.count("start_translate")).toBe(1);

    // B's chain wakes up: it must not restart the server under C.
    ipc.release("save_job_subtitles");
    await settle();
    expect(ipc.count("restart_server")).toBe(1);
    expect(ipc.count("start_translate")).toBe(1);
  });

  it("holds the slot until a restart already in flight returns, then skips the translation", async () => {
    render(<App />);
    await screen.findByText("C_episode.mkv");
    ipc.hold("restart_server");
    await retry("B_episode.mkv"); // B's restart is in flight
    await retry("C_episode.mkv");

    await remove("B_episode.mkv");
    // A second restart on top of B's would race it in the backend.
    expect(ipc.count("restart_server")).toBe(1);
    expect(ipc.count("start_translate")).toBe(0);

    ipc.release("restart_server");
    await settle();
    // B never starts translating; C gets the GPU (its own restart, then start).
    expect(ipc.count("restart_server")).toBe(2);
    expect(ipc.count("start_translate")).toBe(1);
  });

  it("cancels a translation that was still starting, before the next job runs", async () => {
    render(<App />);
    await screen.findByText("C_episode.mkv");
    ipc.hold("start_translate");
    await retry("B_episode.mkv"); // B's start_translate is in flight
    await retry("C_episode.mkv");

    await remove("B_episode.mkv");
    expect(ipc.count("restart_server")).toBe(1);

    // The server hands back B's translation job: it is cancelled, then C runs.
    ipc.release("start_translate");
    await settle();
    expect(ipc.argsOf("cancel_translate")).toEqual([{ jobId: "tr-1" }]);
    expect(ipc.count("restart_server")).toBe(2);
    expect(ipc.count("start_translate")).toBe(2);
  });

  it("cancels a job whose STT was still starting, before the next job runs", async () => {
    render(<App />);
    await screen.findByText("F_episode.mkv");
    ipc.hold("start_stt");
    await retry("F_episode.mkv"); // full retry -> start_stt in flight
    await retry("C_episode.mkv"); // queued behind F

    await remove("F_episode.mkv");
    expect(ipc.count("start_translate")).toBe(0);

    // The server hands back F's STT job: it is cancelled, then C runs.
    ipc.release("start_stt");
    await settle();
    expect(ipc.argsOf("cancel_stt")).toEqual([{ jobId: "stt-1" }]);
    expect(ipc.count("start_translate")).toBe(1);
  });
});
