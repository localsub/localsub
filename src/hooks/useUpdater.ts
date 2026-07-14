import { useState, useCallback } from "react"
import { check } from "@tauri-apps/plugin-updater"

interface UpdateInfo {
  version: string
  body: string | null
}

export function useUpdater() {
  const [checking, setChecking] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [upToDate, setUpToDate] = useState(false)

  const checkForUpdates = useCallback(async () => {
    setChecking(true)
    setError(null)
    setUpdateAvailable(null)
    setUpToDate(false)

    try {
      const update = await check()
      if (update) {
        setUpdateAvailable({
          version: update.version,
          body: update.body ?? null,
        })
      } else {
        setUpToDate(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }, [])

  const installUpdate = useCallback(async () => {
    setInstalling(true)
    setError(null)

    try {
      const update = await check()
      if (update) {
        await update.downloadAndInstall()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }, [])

  return {
    checking,
    updateAvailable,
    installing,
    error,
    upToDate,
    checkForUpdates,
    installUpdate,
  }
}
