import { describe, it, expect, vi, beforeAll } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * The environment step preselected the recommended profile in an effect that
 * also depended on onProfileChange. WizardScreen passes that callback inline,
 * so every pick re-ran the effect and snapped the choice back: on a machine
 * recommended "balanced", Lite and Power could not be selected.
 */

import i18n from "@/i18n";
import { StepEnvironment } from "@/components/wizard/StepEnvironment";
import type { Profile, ProfileRecommendation } from "@/types";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const recommendation: ProfileRecommendation = {
  recommended: "balanced",
  reason: "16GB+ RAM and 4GB+ VRAM detected",
  gpu_detected: true,
  gpu_vram_mb: 8192,
};

// Mirrors WizardScreen: profile lives in parent state, callback passed inline.
function Harness() {
  const [profile, setProfile] = useState<Profile>("lite");
  return (
    <StepEnvironment
      hardware={null}
      recommendation={recommendation}
      loading={false}
      profile={profile}
      onProfileChange={(p) => setProfile(p)}
      onDetect={vi.fn()}
    />
  );
}

describe("wizard profile choice", () => {
  it("preselects the recommended profile", () => {
    render(<Harness />);
    const [, balanced] = screen.getAllByRole("radio");
    expect(balanced).toBeChecked();
  });

  it.each([
    ["lite", 0],
    ["power", 2],
  ])("keeps %s once the user picks it", (_name, index) => {
    render(<Harness />);
    const radio = screen.getAllByRole("radio")[index];
    fireEvent.click(radio);
    expect(radio).toBeChecked();
  });
});
