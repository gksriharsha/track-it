/**
 * Where `invoke` comes from.
 *
 * Inside the Tauri webview it is Tauri's own, unchanged — the real backend, the
 * real database, the real photos. In a plain browser there is no bridge at all
 * and `@tauri-apps/api` throws on the first call, so the same import falls back
 * to the design fixture in `mock.ts`.
 *
 * The test is for Tauri's injected internals rather than for a build flag or a
 * user agent: a production Tauri build must never take the fixture path, and a
 * `pnpm dev` browser tab must never take the Tauri one. `__TAURI_INTERNALS__`
 * is exactly the thing whose presence decides which of those two a window is.
 *
 * The fixture is reached through a dev-only dynamic `import()` rather than a
 * top-level one. A static import put all ~23 KB of fixture text into the
 * shipped bundle, where it was unreachable by construction — `inTauri()` is
 * always true there — but still had to be downloaded, parsed and carried inside
 * the APK. `import.meta.env.DEV` is substituted at build time, so `vite build`
 * drops the branch and never emits the chunk at all. The cost of that is that a
 * production build opened in a plain browser (`pnpm preview`) no longer serves
 * fixtures; `pnpm dev`, which is where the fixture is actually used, is
 * unchanged.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri()) return tauriInvoke<T>(cmd, args);
  if (import.meta.env.DEV) {
    return import("./mock").then((m) => m.mockInvoke<T>(cmd, args ?? {}));
  }
  return Promise.reject(
    new Error(
      `${cmd} needs the Tauri backend. This is a production build with no browser fixture — run \`pnpm dev\` for the fixture, or \`pnpm tauri dev\` for the real backend.`,
    ),
  );
}
