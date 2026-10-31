import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { HardwareInfo, Profile, ProfileRecommendation } from "../../types";
import { HardwareOverview } from "../shared/HardwareOverview";
import { RadioGroup } from "@/components/ui/radio-group";
import { ChoiceCard } from "./ChoiceCard";

const PROFILES: Profile[] = ["lite", "balanced", "power"];

interface StepEnvironmentProps {
  hardware: HardwareInfo | null;
  recommendation: ProfileRecommendation | null;
  loading: boolean;
  profile: Profile;
  onProfileChange: (p: Profile) => void;
  onDetect: () => void;
}

export function StepEnvironment({
  hardware,
  recommendation,
  loading,
  profile,
  onProfileChange,
  onDetect,
}: StepEnvironmentProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!hardware && !loading) {
      onDetect();
    }
  }, [hardware, loading, onDetect]);

  useEffect(() => {
    if (recommendation) {
      onProfileChange(recommendation.recommended);
    }
  }, [recommendation, onProfileChange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2.5 py-12 text-muted-foreground">
        <span className="spinner" />
        <span>{t("wizard.environment.detecting")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
        {t("wizard.environment.title")}
      </h2>

      {/* Hardware cards - 2x2 grid */}
      {hardware && <HardwareOverview hardware={hardware} />}

      {/* Profile selection */}
      <div className="flex flex-col gap-2.5">
        <h3 className="text-sm font-bold text-foreground-secondary">
          {t("wizard.environment.profileTitle")}
        </h3>
        {recommendation && (
          <p className="text-[13px] text-muted-foreground">{recommendation.reason}</p>
        )}
        <RadioGroup
          value={profile}
          onValueChange={(v) => onProfileChange(v as Profile)}
          className="gap-2.5"
        >
          {PROFILES.map((p) => (
            <ChoiceCard key={p} value={p} checked={profile === p} className="py-3.5">
              <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-[15px] font-bold">
                  {t(`wizard.environment.profile.${p}`)}
                </span>
                <p className="text-[13px] text-muted-foreground">
                  {t(`wizard.environment.profileDesc.${p}`)}
                </p>
              </div>
              {recommendation?.recommended === p && (
                <span className="ml-auto inline-flex h-6 shrink-0 items-center rounded-[7px] bg-primary px-[9px] text-xs font-bold text-primary-foreground">
                  {t("wizard.environment.recommended")}
                </span>
              )}
            </ChoiceCard>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}
