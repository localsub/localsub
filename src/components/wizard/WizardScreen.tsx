import { useCallback, useMemo } from "react";
import type { AppConfig, PartialConfig } from "../../types";
import { useWizard } from "../../hooks/useWizard";
import { useHardware } from "../../hooks/useHardware";
import { useModels } from "../../hooks/useModels";
import { WizardLayout } from "./WizardLayout";
import { StepWelcome } from "./StepWelcome";
import { StepEnvironment } from "./StepEnvironment";
import { StepOutput } from "./StepOutput";
import { StepModels } from "./StepModels";
import { StepInstall } from "./StepInstall";

interface WizardScreenProps {
  config: AppConfig;
  onUpdateConfig: (partial: PartialConfig) => Promise<AppConfig>;
  onComplete: () => void;
}

export function WizardScreen({
  config,
  onUpdateConfig,
  onComplete,
}: WizardScreenProps) {
  const { state, updateState, next, back, complete, skip } = useWizard({
    config,
    onUpdateConfig,
  });
  const hw = useHardware();
  const models = useModels();

  const selectedModels = useMemo(() => {
    const ids: string[] = [];
    if (state.selectedWhisperModel) ids.push(state.selectedWhisperModel);
    if (state.selectedLlmModel) ids.push(state.selectedLlmModel);
    return ids;
  }, [state.selectedWhisperModel, state.selectedLlmModel]);

  const handleComplete = useCallback(async () => {
    await complete();
    onComplete();
  }, [complete, onComplete]);

  const handleSkip = useCallback(async () => {
    await skip();
    onComplete();
  }, [skip, onComplete]);

  // Step 1: Welcome (custom layout, no back/next bar)
  if (state.step === 1) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-[600px] rounded-2xl bg-surface p-8">
          <StepWelcome onNext={next} onSkip={handleSkip} />
        </div>
      </div>
    );
  }

  // Steps 2-4: Standard wizard layout
  if (state.step >= 2 && state.step <= 4) {
    const canNext =
      state.step === 2
        ? !!hw.hardware
        : state.step === 3
          ? !!state.outputDir
          : state.step === 4
            ? !!state.selectedWhisperModel
            : true;

    return (
      <WizardLayout
        step={state.step}
        canNext={canNext}
        onBack={back}
        onNext={next}
      >
        {state.step === 2 && (
          <StepEnvironment
            hardware={hw.hardware}
            recommendation={hw.recommendation}
            loading={hw.loading}
            profile={state.profile}
            onProfileChange={(p) => updateState({ profile: p })}
            onDetect={hw.detect}
          />
        )}
        {state.step === 3 && (
          <StepOutput
            outputDir={state.outputDir}
            subtitleFormat={state.subtitleFormat}
            sourceLanguage={state.sourceLanguage}
            targetLanguage={state.targetLanguage}
            onUpdate={updateState}
          />
        )}
        {state.step === 4 && (
          <StepModels
            catalog={models.catalog}
            loading={models.loading}
            profile={state.profile}
            selectedWhisperModel={state.selectedWhisperModel}
            selectedLlmModel={state.selectedLlmModel}
            onSelectWhisper={(id) => updateState({ selectedWhisperModel: id })}
            onSelectLlm={(id) => updateState({ selectedLlmModel: id })}
            onLoadCatalog={models.loadCatalog}
          />
        )}
      </WizardLayout>
    );
  }

  // Step 5: Install (custom layout, no manual next)
  return (
    <WizardLayout
      step={5}
      showNext={false}
      onBack={back}
      onNext={() => {}}
    >
      <StepInstall
        selectedModels={selectedModels}
        downloads={models.downloads}
        manifest={models.manifest}
        onStartDownload={() => {
          if (state.selectedWhisperModel) models.startDownload(state.selectedWhisperModel);
          if (state.selectedLlmModel) models.startDownload(state.selectedLlmModel);
        }}
        onComplete={handleComplete}
        error={models.error}
        onRetry={models.loadCatalog}
      />
    </WizardLayout>
  );
}
