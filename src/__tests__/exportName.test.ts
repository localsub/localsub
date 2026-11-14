import { describe, it, expect } from "vitest";
import { exportBaseName } from "@/lib/exportName";

// The editor's Export button named the file after the job id
// ("335d1ee0-….srt") instead of the source media.
describe("exportBaseName", () => {
  it("uses the source file name without its extension", () => {
    expect(exportBaseName("C:\\Users\\me\\Videos\\sample-en.mp4", "job-1")).toBe("sample-en");
    expect(exportBaseName("/home/me/My Talk.final.mkv", "job-1")).toBe("My Talk.final");
  });

  it("falls back when there is no usable file name", () => {
    expect(exportBaseName(null, "job-1")).toBe("job-1");
    expect(exportBaseName(undefined, "job-1")).toBe("job-1");
    expect(exportBaseName("", "job-1")).toBe("job-1");
    expect(exportBaseName("C:\\videos\\", "job-1")).toBe("job-1");
  });
});
