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
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
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
      <SidebarHeader className="p-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => collapsed ? toggleSidebar() : onNavigate("dashboard")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent transition-colors"
            title={collapsed ? "Expand sidebar" : "LocalSub"}
          >
            <LocalSubLogo size="sm" />
          </button>
          <span className="text-lg font-semibold tracking-tight whitespace-nowrap transition-opacity duration-300 ease-in-out group-data-[collapsible=icon]:opacity-0">
            LocalSub
          </span>
          <button
            onClick={toggleSidebar}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-opacity duration-300 ease-in-out group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:pointer-events-none"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        </div>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent className="p-2">
        <SidebarMenu>
          {NAV_ITEMS.map((item) => (
            <SidebarMenuItem key={item.page}>
              <SidebarMenuButton
                isActive={activePage === item.page}
                tooltip={t(item.i18nKey)}
                onClick={() => onNavigate(item.page)}
              >
                <item.icon className="h-4 w-4" />
                <span>{t(item.i18nKey)}</span>
                {item.page === "dashboard" && processingCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-auto bg-status-info text-status-info-foreground h-5 min-w-5 justify-center text-xs"
                  >
                    {processingCount}
                  </Badge>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarSeparator />

        {/* System status */}
        <div className="flex flex-col gap-1 px-2 py-1.5 transition-opacity duration-300 ease-in-out group-data-[collapsible=icon]:opacity-0">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {hardwareInfo?.gpu ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-status-success shrink-0" />
                <span>CUDA {hardwareInfo.gpu.cuda_version ?? "N/A"} · {(hardwareInfo.gpu.vram_mb / 1024).toFixed(0)}GB VRAM</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-status-warning shrink-0" />
                <span>{t("hw.cpuOnly")}</span>
              </>
            )}
          </div>
          <div
            className={`flex items-center gap-1.5 text-[11px] text-muted-foreground ${
              (serverStatus === "ERROR" || serverStatus === "STOPPED") && onRestartServer
                ? "cursor-pointer hover:text-foreground transition-colors"
                : ""
            }`}
            onClick={() => {
              if ((serverStatus === "ERROR" || serverStatus === "STOPPED") && onRestartServer) {
                onRestartServer();
              }
            }}
          >
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
              serverStatus === "RUNNING" ? "bg-status-success" :
              serverStatus === "STARTING" ? "bg-status-warning animate-pulse" :
              serverStatus === "ERROR" ? "bg-status-error animate-pulse" :
              "bg-muted-foreground/40"
            }`} />
            <span>
              {serverStatus === "RUNNING" ? t("server.running", "Server running") :
               serverStatus === "STARTING" ? t("server.starting", "Starting...") :
               serverStatus === "ERROR" ? t("server.errorClick", "Server error — click to restart") :
               t("server.stopped", "Server stopped")}
            </span>
          </div>
        </div>

        {/* Theme toggle */}
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={t("nav.theme" as const)}>
                  {theme === "dark" ? (
                    <Moon className="h-4 w-4" />
                  ) : theme === "light" ? (
                    <Sun className="h-4 w-4" />
                  ) : (
                    <Monitor className="h-4 w-4" />
                  )}
                  <span>
                    {theme === "dark" ? t("theme.dark") : theme === "light" ? t("theme.light") : t("theme.system")}
                  </span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <Sun className="mr-2 h-4 w-4" />
                  {t("theme.light")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <Moon className="mr-2 h-4 w-4" />
                  {t("theme.dark")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <Monitor className="mr-2 h-4 w-4" />
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
