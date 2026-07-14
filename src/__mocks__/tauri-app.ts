// Mock for @tauri-apps/api/app
export async function getVersion(): Promise<string> {
  return "0.1.0";
}

export async function getName(): Promise<string> {
  return "LocalSub";
}

export async function getTauriVersion(): Promise<string> {
  return "2.0.0";
}
