import {
  LayoutDashboard,
  Subtitles,
  SlidersHorizontal,
  Settings,
  Sun,
  Moon,
  Monitor,
  ChevronsLeft,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { LocalSubLogo } from "@/components/localsub-logo"
import { useTheme } from "@/components/theme-provider"
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { MainPage, HardwareInfo, ServerStatus } from "@/types"

const NAV_ITEMS = [
  { page: "dashboard" as MainPage, icon: LayoutDashboard, i18nKey: "nav.dashboard" as const },
  { page: "editor" as MainPage, icon: Subtitles, i18nKey: "nav.editor" as const },
  { page: "presets" as MainPage, icon: SlidersHorizontal, i18nKey: "nav.presets" as const },
  { page: "settings" as MainPage, icon: Settings, i18nKey: "nav.settings" as const },
]

interface AppSidebarProps {
  activePage: MainPage
  onNavigate: (page: MainPage) => void
  processingCount?: number
  hardwareInfo?: HardwareInfo | null
  serverStatus?: ServerStatus
  onRestartServer?: () => void
}

export function AppSidebar({
  activePage,
  onNavigate,
  processingCount = 0,
  hardwareInfo,
  serverStatus = "STOPPED",
  onRestartServer,
}: AppSidebarProps) {
  const { t } = useTranslation()
  const { setTheme, theme } = useTheme()
  const { toggleSidebar, state } = useSidebar()
  const collapsed = state === "collapsed"

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="px-3.5 pb-5 pt-5">
        <div className="flex h-10 items-center gap-2.5 px-2 group-data-[collapsible=icon]:px-[9px]">
          <button
            onClick={() => collapsed ? toggleSidebar() : onNavigate("dashboard")}
            className="flex h-7 w-7 shrink-0 items-center justify-center"
            title={collapsed ? "Expand sidebar" : "LocalSub"}
          >
            {/* logo.png carries transparent padding; scale it to its visual size */}
            <LocalSubLogo className="h-7 w-7 scale-150" />
          </button>
          <span className="whitespace-nowrap text-[19px] font-extrabold tracking-[-0.03em] text-foreground transition-opacity duration-300 ease-in-out group-data-[collapsible=icon]:opacity-0">
            LocalSub
          </span>
          <button
            onClick={toggleSidebar}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-[opacity,background-color,color] duration-300 ease-in-out hover:bg-muted hover:text-foreground group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3.5">
        <SidebarMenu>
          {NAV_ITEMS.map((item) => (
            <SidebarMenuItem key={item.page}>
              <SidebarMenuButton
                isActive={activePage === item.page}
                tooltip={t(item.i18nKey)}
                onClick={() => onNavigate(item.page)}
              >
                <item.icon />
                <span>{t(item.i18nKey)}</span>
                {item.page === "dashboard" && processingCount > 0 && (
                  <span className="ml-auto flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground">
                    {processingCount}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="gap-2 px-3.5 pb-5 pt-2">
        {/* System status */}
        <div
          className={`flex flex-col gap-2 rounded-lg bg-muted px-4 py-3.5 transition-[opacity,background-color] duration-300 ease-in-out group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0 ${
            (serverStatus === "ERROR" || serverStatus === "STOPPED") && onRestartServer
              ? "cursor-pointer hover:bg-muted-hover"
              : ""
          }`}
          onClick={() => {
            if ((serverStatus === "ERROR" || serverStatus === "STOPPED") && onRestartServer) {
              onRestartServer();
            }
          }}
        >
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <span className={`h-[7px] w-[7px] rounded-full shrink-0 ${
              serverStatus === "RUNNING" ? "bg-status-success" :
              serverStatus === "STARTING" ? "bg-status-warning animate-pulse" :
              serverStatus === "ERROR" ? "bg-status-error animate-pulse" :
              "bg-muted-foreground/40"
            }`} />
            <span className="leading-snug">
              {serverStatus === "RUNNING" ? t("server.running", "Server running") :
               serverStatus === "STARTING" ? t("server.starting", "Starting...") :
               serverStatus === "ERROR" ? t("server.errorClick", "Server error — click to restart") :
               t("server.stopped", "Server stopped")}
            </span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted-foreground">
            {hardwareInfo?.gpu ? (
              <span>CUDA {hardwareInfo.gpu.cuda_version ?? "N/A"} · {(hardwareInfo.gpu.vram_mb / 1024).toFixed(0)}GB VRAM</span>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-status-warning shrink-0" />
                <span>{t("hw.cpuOnly")}</span>
              </>
            )}
          </div>
        </div>

        {/* Theme toggle */}
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="sm" tooltip={t("nav.theme" as const)}>
                  {theme === "dark" ? (
                    <Moon />
                  ) : theme === "light" ? (
                    <Sun />
                  ) : (
                    <Monitor />
                  )}
                  <span>
                    {theme === "dark" ? t("theme.dark") : theme === "light" ? t("theme.light") : t("theme.system")}
                  </span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <Sun />
                  {t("theme.light")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <Moon />
                  {t("theme.dark")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <Monitor />
                  {t("theme.system")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
