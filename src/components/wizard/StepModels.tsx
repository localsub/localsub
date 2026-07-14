import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Languages, HardDrive } from "lucide-react";
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
      <div className="flex items-center justify-center gap-2.5 py-12 text-slate-400">
        <span className="spinner" />
        <span>{t("app.loading")}</span>
      </div>
    );
  }

  const whisperModels = catalog.whisper_models.filter((m) =>
    m.profiles.includes(profile),
  );
  const llmModels = catalog.llm_models.filter((m) =>
    m.profiles.includes(profile),
  );

  const totalSize =
    (whisperModels.find((m) => m.id === selectedWhisperModel)
      ?.total_size_bytes ?? 0) +
    (llmModels.find((m) => m.id === selectedLlmModel)?.size_bytes ?? 0);

  return (
    <div>
      <h2 className="mb-6 text-lg font-semibold text-slate-50">
        {t("wizard.models.title")}
      </h2>

      {/* Whisper models */}
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-slate-300">
        <Mic className="h-4 w-4 text-primary" />
        {t("wizard.models.whisperTitle")}
      </h3>
      <div className="mb-6 flex flex-col gap-2">
        {whisperModels.map((m: WhisperModelEntry) => (
          <ModelRadio
            key={m.id}
            name={m.name}
            size={formatSize(m.total_size_bytes)}
            checked={selectedWhisperModel === m.id}
            onChange={() => onSelectWhisper(m.id)}
          />
        ))}
      </div>

      {/* LLM models */}
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-slate-300">
        <Languages className="h-4 w-4 text-primary" />
        {t("wizard.models.llmTitle")}
      </h3>
      <div className="mb-4 flex flex-col gap-2">
        {llmModels.map((m: LlmModelEntry) => (
          <ModelRadio
            key={m.id}
            name={`${m.name} (${m.quant})`}
            size={formatSize(m.size_bytes)}
            checked={selectedLlmModel === m.id}
            onChange={() => onSelectLlm(m.id)}
          />
        ))}
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-slate-500">
          <input
            type="radio"
            name="llm"
            checked={selectedLlmModel === null}
            onChange={() => onSelectLlm(null)}
            className="accent-primary"
          />
          <span className="text-sm text-slate-400">
            {t("wizard.models.skipLlm")}
          </span>
        </label>
      </div>

      {/* Total size */}
      {totalSize > 0 && (
        <div className="rounded-lg bg-surface-inset p-3 text-center">
          <span className="text-sm text-slate-400">
            {t("wizard.models.totalSize")}:{" "}
          </span>
          <span className="text-sm font-semibold text-slate-200">
            {formatSize(totalSize)}
          </span>
        </div>
      )}
    </div>
  );
}

function ModelRadio({
  name,
  size,
  checked,
  onChange,
}: {
  name: string;
  size: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
        checked
          ? "border-primary bg-primary/10"
          : "border-border hover:border-slate-500"
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="accent-primary"
      />
      <HardDrive className="h-4 w-4 shrink-0 text-slate-500" />
      <span className="text-sm font-medium text-slate-200">{name}</span>
      <span className="ml-auto text-xs text-slate-500">{size}</span>
    </label>
  );
}
