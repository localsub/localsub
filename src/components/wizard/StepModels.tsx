import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Languages } from "lucide-react";
import { RadioGroup } from "@/components/ui/radio-group";
import { ChoiceCard } from "./ChoiceCard";
import { cn } from "@/lib/utils";
import { isQwen, isSelectableStt } from "@/lib/sttModels";
import type {
  ModelCatalog,
  Profile,
  WhisperModelEntry,
  LlmModelEntry,
} from "../../types";

interface StepModelsProps {
  catalog: ModelCatalog | null;
  loading: boolean;
  profile: Profile;
  selectedWhisperModel: string | null;
  selectedLlmModel: string | null;
  onSelectWhisper: (id: string) => void;
  onSelectLlm: (id: string | null) => void;
  onLoadCatalog: () => void;
}

/** RadioGroup value for "skip translation" (selectedLlmModel === null). */
const NO_LLM = "__none__";

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export function StepModels({
  catalog,
  loading,
  profile,
  selectedWhisperModel,
  selectedLlmModel,
  onSelectWhisper,
  onSelectLlm,
  onLoadCatalog,
}: StepModelsProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!catalog && !loading) {
      onLoadCatalog();
    }
  }, [catalog, loading, onLoadCatalog]);

  if (loading || !catalog) {
    return (
      <div className="flex items-center justify-center gap-2.5 py-12 text-muted-foreground">
        <span className="spinner" />
        <span>{t("app.loading")}</span>
      </div>
    );
  }

  // First-run setup offers Whisper only: Qwen3-ASR needs an NVIDIA GPU and a
  // one-time ~3 GB component install, so it is offered in Settings, where the
  // GPU check and its explanation are shown.
  const whisperModels = catalog.whisper_models.filter(
    (m) => m.profiles.includes(profile) && isSelectableStt(m) && !isQwen(m),
  );
  const llmModels = catalog.llm_models.filter((m) =>
    m.profiles.includes(profile),
  );

  const totalSize =
    (whisperModels.find((m) => m.id === selectedWhisperModel)
      ?.total_size_bytes ?? 0) +
    (llmModels.find((m) => m.id === selectedLlmModel)?.size_bytes ?? 0);

  return (
    <div className="flex flex-col gap-[22px]">
      <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
        {t("wizard.models.title")}
      </h2>

      {/* Whisper models */}
      <div className="flex flex-col gap-2.5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-foreground-secondary">
          <Mic className="size-4" />
          {t("wizard.models.whisperTitle")}
        </h3>
        <RadioGroup
          value={selectedWhisperModel ?? ""}
          onValueChange={onSelectWhisper}
          className="gap-2.5"
        >
          {whisperModels.map((m: WhisperModelEntry) => (
            <ModelRadio
              key={m.id}
              value={m.id}
              name={m.name}
              size={formatSize(m.total_size_bytes)}
              license={m.license}
              licenseUrl={m.license_url}
              checked={selectedWhisperModel === m.id}
            />
          ))}
        </RadioGroup>
      </div>

      {/* LLM models */}
      <div className="flex flex-col gap-2.5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-foreground-secondary">
          <Languages className="size-4" />
          {t("wizard.models.llmTitle")}
        </h3>
        <RadioGroup
          value={selectedLlmModel ?? NO_LLM}
          onValueChange={(v) => onSelectLlm(v === NO_LLM ? null : v)}
          className="gap-2.5"
        >
          {llmModels.map((m: LlmModelEntry) => (
            <ModelRadio
              key={m.id}
              value={m.id}
              name={`${m.name} (${m.quant})`}
              size={formatSize(m.size_bytes)}
              license={m.license}
              licenseUrl={m.license_url}
              checked={selectedLlmModel === m.id}
            />
          ))}
          <ChoiceCard value={NO_LLM} checked={selectedLlmModel === null} className="h-[52px]">
            <span className={cn("text-sm font-semibold", selectedLlmModel === null ? "text-foreground" : "text-muted-foreground")}>
              {t("wizard.models.skipLlm")}
            </span>
          </ChoiceCard>
        </RadioGroup>
      </div>

      {/* Total size */}
      {totalSize > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-muted px-[18px] py-4">
          <span className="text-sm text-foreground-secondary">
            {t("wizard.models.totalSize")}
          </span>
          <span className="text-[17px] font-extrabold tabular-nums">
            {formatSize(totalSize)}
          </span>
        </div>
      )}
    </div>
  );
}

function ModelRadio({
  value,
  name,
  size,
  license,
  licenseUrl,
  checked,
}: {
  value: string;
  name: string;
  size: string;
  license: string;
  licenseUrl: string;
  checked: boolean;
}) {
  return (
    <ChoiceCard value={value} checked={checked} className="h-[60px]">
      <span className="min-w-0 truncate text-[15px] font-bold">{name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[13px] text-muted-foreground">
        <a
          href={licenseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-[3px] hover:text-foreground"
        >
          {license}
        </a>
        <span className="tabular-nums">{size}</span>
      </span>
    </ChoiceCard>
  );
}
