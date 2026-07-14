import { useTranslation } from "react-i18next";
import { LocalSubLogo } from "../localsub-logo";

interface StepWelcomeProps {
  onNext: () => void;
  onSkip: () => void;
}

export function StepWelcome({ onNext, onSkip }: StepWelcomeProps) {
  const { t } = useTranslation();

  return (
    <div className="text-center">
      <LocalSubLogo size="lg" className="mx-auto mb-4" />
      <h2 className="mb-4 text-2xl font-bold text-slate-50">
        {t("wizard.welcome.title")}
      </h2>
      <p className="mb-8 text-sm leading-relaxed text-slate-400">
        {t("wizard.welcome.description")}
      </p>
      <div className="flex flex-col items-center gap-3">
        <button
          className="cursor-pointer rounded-md bg-primary px-8 py-3 text-base font-medium text-white transition-opacity hover:opacity-85"
          onClick={onNext}
        >
          {t("wizard.welcome.getStarted")}
        </button>
        <button
          className="cursor-pointer text-xs text-slate-500 transition-colors hover:text-slate-300"
          onClick={onSkip}
        >
          {t("wizard.welcome.skip")}
        </button>
      </div>
    </div>
  );
}
