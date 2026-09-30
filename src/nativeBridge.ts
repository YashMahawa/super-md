import { invoke as tauriInvoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    SuperMD?: { post: (id: string, command: string, args: string) => void };
    supermdReply?: (id: string, result: unknown, error: string | null) => void;
  }
}
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>();
let sequence = 0;
if (typeof window !== "undefined") window.supermdReply = (id, value, error) => {
  const task = pending.get(id); if (!task) return;
  pending.delete(id); window.clearTimeout(task.timer);
  error ? task.reject(new Error(error)) : task.resolve(value);
};
export function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!window.SuperMD) return tauriInvoke<T>(command, args);
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out`)); }, command === "run_python" ? 120_000 : 60_000);
    pending.set(id, { resolve, reject, timer });
    window.SuperMD!.post(id, command, JSON.stringify(args));
  });
}
