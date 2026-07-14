import { useTranslation } from "react-i18next"
import { Cpu, Zap, MemoryStick, AlertTriangle } from "lucide-react"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { useHardware } from "@/hooks/useHardware"
import type { AppConfig, PartialConfig, Profile } from "@/types"

interface PerformanceSectionProps {
  config: AppConfig
  onUpdate: (patch: PartialConfig) => void
}

const PROFILES: { value: Profile; icon: typeof Cpu; titleKey: string; descKey: string }[] = [
  { value: "lite", icon: Cpu, titleKey: "settings.profile.lite", descKey: "settings.profile.liteDesc" },
  { value: "balanced", icon: Zap, titleKey: "settings.profile.balanced", descKey: "settings.profile.balancedDesc" },
  { value: "power", icon: MemoryStick, titleKey: "settings.profile.power", descKey: "settings.profile.powerDesc" },
]

export function PerformanceSection({ config, onUpdate }: PerformanceSectionProps) {
  const { t } = useTranslation()
  const { hardware } = useHardware()

  const gpuEnabled = config.gpu_acceleration ?? true
  const concurrentJobs = config.max_concurrent_jobs ?? 1
  const maxMemory = config.max_memory_mb ?? 0

  // Calculate RAM-based upper limit
  const totalRamMb = hardware ? Math.round(hardware.total_ram_gb * 1024) : 32768
  // Round to nearest 1024 MB
  const maxSliderValue = Math.floor(totalRamMb / 1024) * 1024
  const warningThreshold = Math.round(totalRamMb * 0.8)
  const showWarning = maxMemory > 0 && maxMemory > warningThreshold

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold">{t("settings.performance.title")}</h3>
        <p className="text-sm text-muted-foreground mt-1">{t("settings.performance.description")}</p>
      </div>

      {/* Profile Selection */}
      <div className="flex flex-col gap-3">
        <Label>{t("settings.profile.title")}</Label>
        <RadioGroup
          value={config.profile}
          onValueChange={(v) => onUpdate({ profile: v as Profile })}
          className="flex flex-col gap-2"
        >
          {PROFILES.map((p) => {
            const Icon = p.icon
            return (
              <label
                key={p.value}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-muted/30 ${
                  config.profile === p.value ? "border-primary bg-primary/5" : ""
                }`}
              >
                <RadioGroupItem value={p.value} className="mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{t(p.titleKey as never)}</span>
                    {config.profile === p.value && (
                      <Badge variant="secondary" className="text-[10px] h-4">{t("settings.profile.current")}</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t(p.descKey as never)}</p>
                </div>
              </label>
            )
          })}
        </RadioGroup>
      </div>

      {/* GPU Acceleration */}
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex flex-col gap-0.5">
          <Label>{t("settings.performance.gpuAcceleration")}</Label>
          <p className="text-xs text-muted-foreground">{t("settings.performance.gpuAccelerationDesc")}</p>
        </div>
        <Switch
          checked={gpuEnabled}
          onCheckedChange={(v) => onUpdate({ gpu_acceleration: v })}
        />
      </div>

      {/* Max Concurrent Jobs */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>{t("settings.performance.concurrentJobs")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">{concurrentJobs}</span>
        </div>
        <Slider
          value={[concurrentJobs]}
          onValueChange={([v]) => onUpdate({ max_concurrent_jobs: v })}
          min={1}
          max={4}
          step={1}
        />
        <p className="text-xs text-muted-foreground">{t("settings.performance.concurrentJobsDesc")}</p>
      </div>

      {/* Max Memory */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>{t("settings.performance.maxMemory")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">
            {maxMemory === 0 ? t("settings.performance.unlimited") : `${(maxMemory / 1024).toFixed(1)} GB`}
          </span>
        </div>
        <Slider
          value={[maxMemory]}
          onValueChange={([v]) => onUpdate({ max_memory_mb: v === 0 ? null : v })}
          min={0}
          max={maxSliderValue}
          step={1024}
        />
        <p className="text-xs text-muted-foreground">{t("settings.performance.maxMemoryDesc")}</p>
        {showWarning && (
          <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("settings.memoryWarning")}</span>
          </div>
        )}
      </div>
    </div>
  )
}
