import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "@/i18n";
import { SetupScreen } from "@/components/SetupScreen";
import { LOG_DIR_HINT } from "@/lib/links";
import type { SetupProgress, SetupStatus } from "@/types";

/**
 * The setup ERROR screen is the only place a first-run failure surfaces, and
 * the logs it refers to live under %APPDATA%, not in the install folder — a
 * tester who looks in the install folder finds nothing and has nothing to
 * report. These tests pin the escape hatch: a button that opens the folder,
 * and the literal path next to it for anyone whose file manager won't open.
 */

const baseProps = {
  progress: null as SetupProgress | null,
  error: "boom" as string | null,
  logLines: [] as string[],
  onStart: () => {},
  onRetry: () => {},
  onReset: () => {},
  onOpenLogs: () => {},
};

function renderSetup(status: SetupStatus, overrides: Partial<typeof baseProps> = {}) {
  return render(<SetupScreen status={status} {...baseProps} {...overrides} />);
}

describe("SetupScreen log escape hatch", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("offers to open the log folder when setup fails", () => {
    const onOpenLogs = vi.fn();
    renderSetup("ERROR", { onOpenLogs });

    fireEvent.click(screen.getByRole("button", { name: /open log folder/i }));

    expect(onOpenLogs).toHaveBeenCalledTimes(1);
  });

  it("shows the literal log path so it can be copied into a bug report", () => {
    renderSetup("ERROR");

    expect(screen.getByText(LOG_DIR_HINT)).toBeInTheDocument();
  });

  it("still offers the logs when the failure has a friendly explanation", () => {
    // A classified error (disk/network/…) replaces the raw message, but the
    // underlying pip output is still what we need back from the user.
    renderSetup("ERROR", {
      progress: {
        stage: "requirements" as const,
        message: "Not enough free disk space",
        progress: 0,
        error_kind: "disk" as const,
      },
    });

    expect(screen.getByRole("button", { name: /open log folder/i })).toBeInTheDocument();
  });

  it("does not offer the logs before setup has been attempted", () => {
    renderSetup("NEEDED");

    expect(screen.queryByRole("button", { name: /open log folder/i })).toBeNull();
  });
});
