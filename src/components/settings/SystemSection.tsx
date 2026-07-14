import { useTranslation } from "react-i18next"
import { Cpu, MemoryStick, Monitor, Microchip, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useHardware } from "@/hooks/useHardware"
import type { LucideIcon } from "lucide-react"

export function SystemSection() {
  const { t } = useTranslation()
  const { hardware, loading, detect } = useHardware()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{t("settings.system.title")}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t("settings.system.description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={detect} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.system.refresh")}
        </Button>
      </div>

      {loading && !hardware ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="spinner" />
          {t("settings.profile.detecting")}
        </div>
      ) : hardware ? (
        <div className="grid grid-cols-2 gap-3">
          <HwCard
            icon={Cpu}
            label={t("wizard.environment.cpuCard")}
            value={hardware.cpu_name}
            sub={`${hardware.cpu_cores} cores`}
          />
          <HwCard
            icon={MemoryStick}
            label={t("wizard.environment.ramCard")}
            value={`${hardware.total_ram_gb.toFixed(1)} GB`}
            sub={`${hardware.available_ram_gb.toFixed(1)} GB free`}
          />
          <HwCard
            icon={Monitor}
            label={t("wizard.environment.gpuCard")}
            value={hardware.gpu?.name ?? t("wizard.environment.noGpu")}
            sub={hardware.gpu ? `${hardware.gpu.vram_mb} MB VRAM${hardware.gpu.cuda_version ? ` • CUDA ${hardware.gpu.cuda_version}` : ""}` : undefined}
          />
          <HwCard
            icon={Microchip}
            label={t("wizard.environment.diskCard")}
            value={hardware.avx2_support ? "AVX2" : hardware.avx_support ? "AVX" : "SSE"}
            sub={t("wizard.environment.instructionSet")}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("settings.system.noData")}</p>
      )}
    </div>
  )
}

function HwCard({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="truncate text-sm font-medium">{value}</p>
      {sub && <p className="truncate text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}
