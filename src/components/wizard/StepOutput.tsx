import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { pickDirectory } from "../../lib/tauriApi";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const FORMATS = ["srt", "vtt", "ass", "txt"];
const LANGUAGES = [
  "en", "ko", "ja", "zh", "es", "fr", "de", "pt", "ru", "ar",
];

interface StepOutputProps {
  outputDir: string;
  subtitleFormat: string;
  sourceLanguage: string;
  targetLanguage: string;
  onUpdate: (patch: {
    outputDir?: string;
    subtitleFormat?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
  }) => void;
}

export function StepOutput({
  outputDir,
  subtitleFormat,
  sourceLanguage,
  targetLanguage,
  onUpdate,
}: StepOutputProps) {
  const { t } = useTranslation();

  const handleBrowse = async () => {
    const selected = await pickDirectory();
    if (selected) {
      onUpdate({ outputDir: selected });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
        {t("wizard.output.title")}
      </h2>

      {/* Output folder */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-bold text-foreground-secondary">
          {t("wizard.output.folderLabel")}
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={outputDir}
            title={outputDir}
            className="h-[52px] min-w-0 flex-1 truncate rounded-lg bg-muted px-4 text-[15px] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          />
          <Button
            className="h-[52px] bg-primary-soft px-[18px] text-primary-text hover:bg-primary-soft/70"
            onClick={handleBrowse}
          >
            {t("wizard.output.browse")}
          </Button>
        </div>
      </div>

      {/* Subtitle format */}
      <div className="flex flex-col gap-2">
        <label id="wizard-format-label" className="text-sm font-bold text-foreground-secondary">
          {t("wizard.output.formatLabel")}
        </label>
        <RadioGroupPrimitive.Root
          value={subtitleFormat}
          onValueChange={(v) => onUpdate({ subtitleFormat: v })}
          aria-labelledby="wizard-format-label"
          className="grid grid-cols-4 gap-0.5 rounded-lg bg-muted p-1"
        >
          {FORMATS.map((f) => (
            <RadioGroupPrimitive.Item
              key={f}
              value={f}
              className="h-11 cursor-pointer rounded-sm text-[15px] font-semibold text-foreground-secondary transition-[background-color,color,box-shadow] duration-150 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-card data-[state=checked]:font-bold data-[state=checked]:text-foreground data-[state=checked]:shadow-segment"
            >
              .{f}
            </RadioGroupPrimitive.Item>
          ))}
        </RadioGroupPrimitive.Root>
      </div>

      {/* Source → target language */}
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-sm font-bold text-foreground-secondary">
            {t("wizard.output.sourceLanguage")}
          </label>
          <Select
            value={sourceLanguage}
            onValueChange={(v) => onUpdate({ sourceLanguage: v })}
          >
            <SelectTrigger className="h-[52px] rounded-lg font-bold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ArrowRight className="mb-4 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="text-sm font-bold text-foreground-secondary">
            {t("wizard.output.targetLanguage")}
          </label>
          <Select
            value={targetLanguage}
            onValueChange={(v) => onUpdate({ targetLanguage: v })}
          >
            <SelectTrigger className="h-[52px] rounded-lg font-bold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
