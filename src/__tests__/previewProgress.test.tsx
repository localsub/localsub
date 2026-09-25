import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * The backend reports STT and translation progress only as `job-updated`
 * events (sse_client.rs turns the Python *_progress messages into a Job with
 * `progress`). The preview must read its progress from there — it used to
 * wait for `stt-progress` / `translate-progress`, which nothing emits, so the
 * bar sat at 0 until it jumped to 100.
 */

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  return {
    listeners,
    emit(event: string, payload: unknown) {
      for (const h of listeners.get(event) ?? []) h({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    if (!bus.listeners.has(event)) bus.listeners.set(event, new Set());
    bus.listeners.get(event)!.add(handler);
    return () => bus.listeners.get(event)?.delete(handler);
  },
  emit: async () => {},
}));

vi.mock("@/lib/tauriApi", () => ({
  startStt: async () => ({ id: "stt-1", state: "RUNNING", progress: 0, message: "" }),
  startTranslate: async () => ({ id: "tr-1", state: "RUNNING", progress: 0, message: "" }),
  cancelStt: async () => {},
  cancelTranslate: async () => {},
}));

import i18n from "@/i18n";
import { usePreviewPipeline } from "@/hooks/usePreviewPipeline";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function send(event: string, payload: unknown) {
  await act(async () => bus.emit(event, payload));
  await flush();
}

describe("preview progress", () => {
  it("follows the job-updated progress of the STT and then the translation job", async () => {
    const { result } = renderHook(() => usePreviewPipeline());

    act(() => {
      void result.current.startPreview("D:/a.mkv", "preset-1", 0, 60);
    });
    await flush();
    expect(result.current.phase).toBe("stt");
    expect(result.current.message).toBe("Transcribing...");

    await send("job-updated", { id: "stt-1", state: "RUNNING", progress: 40, message: "Transcribing... (3 segments)" });
    expect(result.current.progress).toBe(40);

    await send("stt-segment", { job_id: "stt-1", index: 0, start: 1, end: 2, text: "hello there" });
    await send("job-updated", { id: "stt-1", state: "DONE", progress: 100, message: "" });
    expect(result.current.phase).toBe("translating");
    expect(result.current.message).toBe("Translating...");
    expect(result.current.progress).toBe(0);

    await send("job-updated", { id: "tr-1", state: "RUNNING", progress: 60, message: "Translating... (1/2 segments)" });
    expect(result.current.progress).toBe(60);

    await send("job-updated", { id: "tr-1", state: "DONE", progress: 100, message: "" });
    expect(result.current.phase).toBe("done");
    expect(result.current.message).toBe("Done");
  });
});
