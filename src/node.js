// Execution host. Node only.
//
// This exists because compiling is not validation. Measured against the v0.28.0
// artifact, the compiler accepts all of these without a single diagnostic:
//
//   deka.http.fetchJSON("...")   an invented stdlib call
//   totallyMadeUp()              an invented global
//   add(1, 2, 3)                 wrong arity against a 1-arg fn
//
// It rejects syntax errors and little else. "Model invents a plausible API that
// does not exist" is the likeliest failure in generated code, and compiling will
// not catch it -- executing will, as a ReferenceError or TypeError.
//
// Caveat worth knowing: execution only catches code that actually runs. A bad
// call behind an unexercised branch still passes. Samples derived from testsuite
// fixtures do not have that gap.

import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { instantiate } from './compiler.js';
import { createRuntimeGlobals } from '../vendor/runtime-globals.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Instantiate the compiler bundled with this package.
 *
 * Lives here rather than in the universal entry because it reads the wasm off
 * disk, and a bundler resolves that import even when it sits inside a function.
 *
 * The instance is stateless between calls and safe to reuse for the life of the
 * process. Callers should: instantiating a 6.6MB module is not free.
 */
export async function load() {
  const path = fileURLToPath(new URL('../wasm/deka_compiler.wasm', import.meta.url));
  return instantiate(await readFile(path));
}

/**
 * Strip module-level syntax that cannot be evaluated inside a vm script.
 *
 * Carried over from the runtime-suite harness. It means run() does not execute
 * byte-for-byte what a user would ship -- tracked, and the reason `js` is always
 * returned so a caller can inspect the real output.
 */
function stripModuleArtifacts(code) {
  return code
    .replace(/^export const \w+ = [^;]+;\n?/gm, '')
    .replace(/^export async function \w+[\s\S]*$/m, '')
    .replace(/^export function \w+[\s\S]*$/m, '')
    .replace(/^import\s+\{\s*jsx,\s*jsxs\s*\}\s+from\s+['"]component\/core['"];?\n?/gm, '');
}

let shared = null;

/** Reuse one compiler instance across calls; instantiation dominates otherwise. */
async function sharedCompiler() {
  if (!shared) shared = await load();
  return shared;
}

/**
 * Compile and execute DekaScript, returning what it printed.
 *
 * Never throws for bad input -- a compile failure, a runtime error, and a
 * timeout are all normal results with `ok: false`. Callers validating generated
 * code want a verdict, not an exception to catch.
 *
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, js: string,
 *                     phase: 'compile'|'run'|'ok', diagnostics: Array}>}
 */
export async function run(source, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, filename = 'snippet.ds', compiler } = opts;
  const deka = compiler ?? await sharedCompiler();

  const compiled = deka.compile(source, { filename });
  if (!compiled.ok) {
    return {
      ok: false,
      phase: 'compile',
      stdout: '',
      stderr: compiled.stderr,
      js: compiled.js,
      diagnostics: compiled.diagnostics,
    };
  }

  const { globals, output, errorOutput } = createRuntimeGlobals();
  const context = vm.createContext(globals);

  try {
    const script = new vm.Script(`(async () => { ${stripModuleArtifacts(compiled.js)} })()`);
    const promise = script.runInContext(context, { timeout: timeoutMs });
    if (promise && typeof promise.then === 'function') await promise;
    // Nested async components (Suspense resolution) need a turn to drain before
    // stdout is snapshotted.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } catch (error) {
    return {
      ok: false,
      phase: 'run',
      stdout: output.join(''),
      stderr: [...errorOutput, String(error?.stack ?? error)].join('\n'),
      js: compiled.js,
      diagnostics: compiled.diagnostics,
    };
  }

  // JSX templates write rendered output here rather than to stdout.
  const templateBody = context.__phpxCurrentResponse?.body;
  const stderr = errorOutput.join('');

  return {
    ok: true,
    phase: 'ok',
    stdout: output.join('') || (typeof templateBody === 'string' ? templateBody : ''),
    stderr,
    js: compiled.js,
    diagnostics: compiled.diagnostics,
  };
}

/**
 * Verdict-only wrapper for validating a candidate snippet.
 *
 * `contributed` guards a specific trap: the compiler emits a ~1.7KB prelude for
 * *any* input, including an empty string, so "it compiled and produced output"
 * is not evidence the snippet did anything. This compares against the prelude
 * baseline for the same compiler.
 */
export async function check(source, opts = {}) {
  const deka = opts.compiler ?? await sharedCompiler();
  const baseline = deka.compile('').js.length;
  const result = await run(source, { ...opts, compiler: deka });
  return {
    ...result,
    contributed: result.js.length > baseline,
  };
}

export { instantiate, Compiler, bundledWasmInfo, wasmVersion, wasmSourceCommit } from './index.js';
