/**
 * The few Node built-ins the `*.test.ts` files under `src/lib` read the disk
 * with, declared by hand.
 *
 * Those tests run in a bare Node process (`pnpm test`), but they sit under
 * `src`, so `pnpm build`'s `tsc` typechecks them with the app — and this
 * repository does not install `@types/node` (see the header of
 * exportSheet.test.ts). A machine that happens to have it in a parent
 * directory finds it anyway and passes; CI's clean install does not, and
 * failed on the first test that imported `node:fs`. These declarations are the
 * exact surface the tests use and nothing more, as modules rather than
 * globals: app code cannot reach `process` or the filesystem by accident, and
 * a test that needs another function adds it here, checked.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
