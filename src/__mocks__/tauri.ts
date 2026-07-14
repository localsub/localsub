// Mock for @tauri-apps/api/core
export async function invoke(_cmd: string, _args?: unknown): Promise<unknown> {
  return {};
}

export function convertFileSrc(path: string): string {
  return `asset://localhost/${path}`;
}
