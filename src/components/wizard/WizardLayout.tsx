import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
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
      <div className="flex max-h-[calc(100vh-3rem)] w-full max-w-[600px] flex-col">
        {/* Step indicator */}
        <div className="mb-8 flex shrink-0 items-center justify-center gap-2">
          {Array.from({ length: STEP_COUNT }, (_, i) => {
            const s = (i + 1) as WizardStep;
            const isActive = s === step;
            const isDone = s < step;
            return (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                    isActive
                      ? "bg-primary text-white"
                      : isDone
                        ? "bg-primary/20 text-primary"
                        : "bg-surface text-slate-500"
                  }`}
                >
                  {isDone ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  ) : (
                    s
                  )}
                </div>
                {s < STEP_COUNT && (
                  <div
                    className={`h-0.5 w-6 ${
                      isDone ? "bg-primary/40" : "bg-surface"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Step label */}
        <p className="mb-6 shrink-0 text-center text-xs font-medium uppercase tracking-wider text-slate-500">
          {t(`wizard.stepLabels.${step}`)}
        </p>

        {/* Content — scrolls internally when the step is taller than the viewport */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-surface p-8">
          {children}
        </div>

        {/* Navigation */}
        <div className="mt-6 flex shrink-0 justify-between">
          {showBack && step > 1 ? (
            <button
              className="cursor-pointer rounded-md px-4 py-2 text-sm text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
              onClick={onBack}
            >
              {t("wizard.back")}
            </button>
          ) : (
            <div />
          )}
          {showNext && (
            <button
              className="cursor-pointer rounded-md bg-primary px-6 py-2 text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={onNext}
              disabled={!canNext}
            >
              {nextLabel ?? t("wizard.next")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
