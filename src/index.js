// Universal entry point. Nothing here imports a Node builtin at module scope,
// so this file is safe to bundle into a Cloudflare Worker or a browser.
//
// Two ways in:
//
//   Node / CI
//     import { load } from '@dekaruntime/headless';
//     const deka = await load();
//
//   Cloudflare Worker (modules are imported at build time, not fetched)
//     import wasm from '@dekaruntime/headless/wasm';
//     import { instantiate } from '@dekaruntime/headless';
//     const deka = await instantiate(wasm);
//
// `run()` lives in '@dekaruntime/headless/node' because executing compiled
// output needs a JS host, and this package deliberately never shells out to a
// native deka binary. See README: "What compiling does and does not catch".

export { Compiler, instantiate } from './compiler.js';
export { bundledWasmInfo, wasmVersion, wasmSourceCommit } from './wasm-info.js';

/**
 * Instantiate the compiler bundled with this package.
 *
 * Node only -- it reads the wasm off disk. In a Worker, import the module and
 * hand it to `instantiate()` instead.
 *
 * The instance is stateless between calls and safe to reuse for the life of the
 * process. Callers should: instantiating a 6.6MB module is not free.
 */
export async function load() {
  const { instantiate } = await import('./compiler.js');
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import('node:fs/promises'),
    import('node:url'),
  ]);
  const path = fileURLToPath(new URL('../wasm/deka_compiler.wasm', import.meta.url));
  return instantiate(await readFile(path));
}
