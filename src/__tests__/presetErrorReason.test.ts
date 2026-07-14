import { describe, it, expect } from "vitest";
import { reason } from "../hooks/usePresets";

describe("reason", () => {
  it("passes through a Tauri command rejection, which is a plain string", () => {
    // `AppError` serializes to its Display impl, so this is what `invoke` throws.
    const err = "Config error: C:\\Users\\me\\AppData\\Roaming\\LocalSub\\presets.json:1:1: expected value";
    expect(reason(err)).toBe(err);
  });

  it("unwraps an Error", () => {
    expect(reason(new Error("boom"))).toBe("boom");
  });

  it("returns undefined for things with no message, so the toast stays clean", () => {
    expect(reason(undefined)).toBeUndefined();
    expect(reason(null)).toBeUndefined();
    expect(reason({ code: 42 })).toBeUndefined();
    expect(reason("")).toBeUndefined();
    expect(reason("   ")).toBeUndefined();
    expect(reason(new Error(""))).toBeUndefined();
  });
});
