import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WizardStep } from "../../types";

const STEP_COUNT = 5;

interface WizardLayoutProps {
  step: WizardStep;
  children: ReactNode;
  canNext?: boolean;
  showBack?: boolean;
  showNext?: boolean;
  nextLabel?: string;
  onBack: () => void;
  onNext: () => void;
}

/** Segmented progress bar plus "n / 5 · label", shown above every step. */
export function StepIndicator({ step }: { step: WizardStep }) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 flex-col gap-2.5">
      <div className="flex gap-1.5" aria-hidden>
        {Array.from({ length: STEP_COUNT }, (_, i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-200",
              i < step ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </div>
      <p className="text-[13px] font-semibold text-muted-foreground">
        {step} / {STEP_COUNT} · {t(`wizard.stepLabels.${step}`)}
      </p>
    </div>
  );
}

export function WizardLayout({
  step,
  children,
  canNext = true,
  showBack = true,
  showNext = true,
  nextLabel,
  onBack,
  onNext,
}: WizardLayoutProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {/* Cap the card to the viewport and let the content scroll, so the
          Back/Next footer stays visible even when a step (e.g. the model
          list) is taller than the screen. */}
      <div className="flex max-h-[calc(100vh-3rem)] w-full max-w-[600px] flex-col gap-6">
        <StepIndicator step={step} />

        {/* Content — scrolls internally when the step is taller than the viewport */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-3xl bg-card p-9 shadow-card">
          {children}
        </div>

        {/* Navigation */}
        <div className="flex shrink-0 justify-between">
          {showBack && step > 1 ? (
            <Button
              variant="ghost"
              className="h-[52px] px-[22px] text-base"
              onClick={onBack}
            >
              {t("wizard.back")}
            </Button>
          ) : (
            <div />
          )}
          {showNext && (
            <Button
              className="h-[52px] px-9 text-base"
              onClick={onNext}
              disabled={!canNext}
            >
              {nextLabel ?? t("wizard.next")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
