import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import type { VcRedistAttempt, VcRedistState } from "@/types";

/**
 * The runtime card is rendered inside App, so anything it throws takes the
 * whole window with it. It also carries the one line that makes a retry
 * useful — where the last attempt stopped — which has to survive the case the
 * record exists precisely for: an attempt that never finished.
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

const { VcRedistCard } = await import("@/components/shared/VcRedistCard");
const { isUsableVcRedistState } = await import("@/hooks/useVcRedist");

function stateWith(overrides: Partial<VcRedistState> = {}): VcRedistState {
  return {
    status: { missing: ["msvcp140.dll"], core_blocked: true },
    last_attempt: null,
    ...overrides,
  };
}

function attempt(overrides: Partial<VcRedistAttempt> = {}): VcRedistAttempt {
  return {
    stage: "consent",
    outcome: null,
    kind: null,
    detail: null,
    exit_code: null,
    bytes_downloaded: 0,
    bytes_total: 0,
    at_epoch_secs: 1_755_000_000,
    ...overrides,
  };
}

describe("VcRedistCard", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    invoke.mockReset();
  });

  /** A payload without `status` must not blank the app. */
  it("survives a malformed payload instead of throwing", async () => {
    invoke.mockResolvedValue({} as unknown as VcRedistState);

    expect(() => render(<VcRedistCard />)).not.toThrow();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing as a banner while the runtime is present", async () => {
    invoke.mockResolvedValue(stateWith({ status: { missing: [], core_blocked: false } }));

    const { container } = render(<VcRedistCard />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the install and warns about the prompt before it appears", async () => {
    invoke.mockResolvedValue(stateWith());

    render(<VcRedistCard />);

    expect(await screen.findByText(/required runtime is missing/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /install runtime/i })).toBeInTheDocument();
    // The prompt names Microsoft, not LocalSub; unexplained, it reads as malware.
    expect(screen.getByText(/administrator permission/i)).toBeInTheDocument();
    expect(screen.getByText(/msvcp140\.dll/)).toBeInTheDocument();
  });

  /**
   * The whole point of writing the record when an attempt *starts*: an attempt
   * with no outcome was interrupted, and saying so is different from saying
   * nothing.
   */
  it("says an unfinished attempt was interrupted, not that it failed", async () => {
    invoke.mockResolvedValue(stateWith({ last_attempt: attempt({ stage: "consent" }) }));

    render(<VcRedistCard />);

    expect(await screen.findByText(/interrupted during/i)).toBeInTheDocument();
    expect(screen.getByText(/interrupted during/i).textContent).toMatch(/permission prompt/i);
    expect(screen.queryByText(/failed during/i)).not.toBeInTheDocument();
  });

  it("reports a declined prompt as a choice, with the retry still offered", async () => {
    invoke.mockResolvedValue(
      stateWith({ last_attempt: attempt({ stage: "consent", outcome: "declined" }) }),
    );

    render(<VcRedistCard />);

    expect(await screen.findByText(/permission prompt was dismissed/i)).toBeInTheDocument();
    expect(screen.getByText(/install it at any time/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /install again/i })).toBeInTheDocument();
  });

  it("names the stage and keeps the installer exit code when one failed", async () => {
    invoke.mockResolvedValue(
      stateWith({
        last_attempt: attempt({
          stage: "install",
          outcome: "failed",
          kind: "unknown",
          detail: "The Visual C++ installer failed with code 5",
          exit_code: 5,
        }),
      }),
    );

    render(<VcRedistCard />);

    expect(await screen.findByText(/failed during/i)).toBeInTheDocument();
    expect(screen.getByText(/Installer exit code: 5/)).toBeInTheDocument();
    expect(screen.getByText(/tauri\.log/)).toBeInTheDocument();
  });
});

describe("isUsableVcRedistState", () => {
  it("accepts the shape the card actually reads", () => {
    expect(isUsableVcRedistState(stateWith())).toBe(true);
    expect(
      isUsableVcRedistState(stateWith({ status: { missing: [], core_blocked: false } })),
    ).toBe(true);
  });

  /**
   * Each of these once reached the component and threw during render, which in
   * App means a blank window. A runtime probe that cannot answer must cost
   * nothing.
   */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["a status without missing", { status: { core_blocked: true } }],
    ["missing as a string", { status: { missing: "msvcp140.dll", core_blocked: true } }],
    ["core_blocked absent", { status: { missing: [] } }],
  ])("rejects %s", (_label, value) => {
    expect(isUsableVcRedistState(value)).toBe(false);
  });
});
