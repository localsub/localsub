import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LocalSubLogo } from "../localsub-logo";

interface StepWelcomeProps {
  onNext: () => void;
  onSkip: () => void;
}

export function StepWelcome({ onNext, onSkip }: StepWelcomeProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <LocalSubLogo className="mb-3 h-[72px] w-[72px] scale-150" />
      <h2 className="text-[28px] font-extrabold leading-[1.3] tracking-[-0.03em] text-balance">
        {t("wizard.welcome.title")}
      </h2>
      <p className="text-base leading-[1.6] text-foreground-secondary text-pretty">
        {t("wizard.welcome.description")}
      </p>
      <div className="mt-5 flex w-full flex-col items-center gap-4">
        <Button className="h-14 w-full rounded-[16px] text-[17px]" onClick={onNext}>
          {t("wizard.welcome.getStarted")}
        </Button>
        <button
          className="cursor-pointer rounded-sm p-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onSkip}
        >
          {t("wizard.welcome.skip")}
        </button>
      </div>
    </div>
  );
}
