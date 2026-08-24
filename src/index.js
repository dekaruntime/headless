// Universal entry point. Worker-safe, browser-safe, Node-safe.
//
// There is deliberately NO reference to a node: builtin in this file, not even
// a dynamic `await import('node:fs')` inside a function body. Bundlers resolve
// those statically: an earlier version had `load()` here, and every Worker that
// imported this module got a "may throw errors at runtime unless you enable
// nodejs_compat" warning and pulled a Node shim into the bundle. Function scope
// is not module scope as far as esbuild is concerned.
//
// Anything that touches the filesystem or executes code lives in ./node.js.
//
//   Cloudflare Worker / browser
//     import wasm from '@dekaruntime/headless/wasm';
//     import { instantiate } from '@dekaruntime/headless';
//     const deka = await instantiate(wasm);
//
//   Node / CI
//     import { load, run } from '@dekaruntime/headless/node';

export { Compiler, instantiate } from './compiler.js';
export { bundledWasmInfo, wasmVersion, wasmSourceCommit } from './wasm-info.js';
