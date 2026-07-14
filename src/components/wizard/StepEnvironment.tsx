import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { HardwareInfo, Profile, ProfileRecommendation } from "../../types";
import { HardwareOverview } from "../shared/HardwareOverview";

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
      <div className="flex items-center justify-center gap-2.5 py-12 text-slate-400">
        <span className="spinner" />
        <span>{t("wizard.environment.detecting")}</span>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-6 text-lg font-semibold text-slate-50">
        {t("wizard.environment.title")}
      </h2>

      {/* Hardware cards - 2x2 grid */}
      {hardware && (
        <div className="mb-8">
          <HardwareOverview hardware={hardware} />
        </div>
      )}

      {/* Profile selection */}
      <h3 className="mb-3 text-sm font-medium text-slate-300">
        {t("wizard.environment.profileTitle")}
      </h3>
      {recommendation && (
        <p className="mb-3 text-xs text-slate-500">{recommendation.reason}</p>
      )}
      <div className="flex flex-col gap-2">
        {PROFILES.map((p) => (
          <label
            key={p}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
              profile === p
                ? "border-primary bg-primary/10"
                : "border-border hover:border-slate-500"
            }`}
          >
            <input
              type="radio"
              name="profile"
              checked={profile === p}
              onChange={() => onProfileChange(p)}
              className="accent-primary"
            />
            <div>
              <span className="text-sm font-medium text-slate-200">
                {t(`wizard.environment.profile.${p}`)}
              </span>
              <p className="text-xs text-slate-500">
                {t(`wizard.environment.profileDesc.${p}`)}
              </p>
            </div>
            {recommendation?.recommended === p && (
              <span className="ml-auto rounded-full bg-primary/20 px-2 py-0.5 text-xs text-primary">
                {t("wizard.environment.recommended")}
              </span>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}
