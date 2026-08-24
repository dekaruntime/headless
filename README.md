# @dekaruntime/headless

Compile and run DekaScript from JavaScript, using the same wasm compiler the
browser tour uses. No native binary, no toolchain, no network at call time — the
compiler ships inside the package.

```bash
npm i @dekaruntime/headless
```

```js
import { load } from '@dekaruntime/headless/node';

const deka = await load();
const { ok, js, stderr } = deka.compile('fn add(a: number, b: number) number { return a + b; }');
```

```js
import { run } from '@dekaruntime/headless/node';

const { ok, stdout, stderr, phase } = await run('fn main() { console.log("hi"); }\nmain();');
// { ok: true, stdout: 'hi\n', phase: 'ok' }
```

## What compiling does and does not catch

This is the most important thing to know before trusting a result.

Measured against the bundled compiler, all of these produce `ok: true` and zero
diagnostics:

| source | compiles | runs |
|---|---|---|
| `totallyMadeUp()` | yes | **ReferenceError** |
| `deka.http.fetchJSON("x")` | yes | **TypeError** |
| `add(1, 2, 3)` against a 1-arg `fn` | yes | depends |
| `fnc main() {}` | **no** | — |

Compiling catches syntax, and not much beyond it. If you are validating code
that something *generated* — a model, a template, a docs example — compiling is
not enough, because "invents a plausible API that does not exist" is the most
likely way that code is wrong, and it compiles clean.

Use `run()` when the question is "is this real," and `compile()` when the
question is "is this well-formed."

Two limits worth stating: `run()` only catches code that actually executes, so a
bad call behind an untaken branch still passes; and an empty string compiles
successfully to a ~1.7KB prelude, so "it produced output" is not evidence of
anything. `check()` returns `contributed: false` for that case.

## API

### `load()` → `Promise<Compiler>` — Node only

Instantiates the bundled compiler by reading the wasm off disk. Exported from
`@dekaruntime/headless/node`, not the universal entry: bundlers resolve a
`node:` import even inside a function body, so keeping it out of the root entry
is what makes that entry genuinely Worker-safe.
Instances are stateless between calls and meant to be reused; instantiating a
6.6MB module per call will dominate everything else you do.

### `instantiate(moduleOrBytes)` → `Promise<Compiler>`

For hosts where you supply the module yourself. See [Cloudflare Workers](#cloudflare-workers).

### `compiler.compile(source, { filename?, mode? })`

`{ ok, js, diagnostics, stderr, raw }`. A source that does not compile is
`ok: false` — a normal result, not an exception. A thrown error means the
compiler itself misbehaved.

### `run(source, { timeoutMs?, filename?, compiler? })` → Node only

`{ ok, stdout, stderr, js, phase, diagnostics }`, where `phase` is `compile`,
`run`, or `ok` — so you can tell "did not compile" from "compiled and then
blew up". Never throws for bad input.

### `check(source, opts)` → Node only

`run()` plus `contributed`, which is false when the snippet added nothing to the
prelude.

## Cloudflare Workers

The artifact is a bare `wasm32-unknown-unknown` module with **zero imports**, so
it needs no glue. It runs in a Worker — verified against `workerd` over real
HTTP, not just bundled.

One wrinkle, and it is not optional: **Wrangler's module rules do not apply to
files inside `node_modules`.** Importing `@dekaruntime/headless/wasm` directly
fails with `No loader is configured for ".wasm" files`, and no `globs` pattern
fixes it — `node_modules/**/*.wasm`, `**/node_modules/**/*.wasm` and
`fallthrough = true` were all tried. Copy the wasm into your own source tree:

```json
{ "scripts": { "prebuild": "cp node_modules/@dekaruntime/headless/wasm/deka_compiler.wasm src/" } }
```

```toml
# wrangler.toml
[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
```

```js
import wasm from './deka_compiler.wasm';
import { instantiate } from '@dekaruntime/headless';

let compiler;
export default {
  async fetch(request) {
    compiler ??= await instantiate(wasm);           // once per isolate
    const { ok, stderr } = compiler.compile(await request.text());
    return Response.json({ ok, stderr });
  },
};
```

`run()` is not available here — executing compiled output needs a JS host. A
Worker can answer "is this well-formed"; it cannot answer "is this real". The
difference is not academic: a Worker returns `ok: true` for
`fn main() { totallyMadeUp(); }`. Do that check in CI.

## Which compiler is in here

```js
import { bundledWasmInfo, wasmVersion, wasmSourceCommit } from '@dekaruntime/headless';
```

`wasmVersion` is what the **artifact reports about itself**, not what the release
was tagged. Those can differ: the bytes are what the compiler *is*, the tag is
what we *meant* to publish, and when they disagree the tag is the thing that is
wrong (dekaruntime/deka#279). `sourceCommit` and `sha256` identify the build
unambiguously and are the fields to pin against.

### Which package version carries which runtime

<!-- runtime-map:start -->
| package | deka runtime | artifact self-reports |
|---|---|---|
| `>=0.1.3` | `0.29.0` | `0.29.0` |
| `>=0.1.3` | `0.28.0` | — |
<!-- runtime-map:end -->

Generated by `sync-wasm.mjs` in the same commit that moves the pin, so it cannot
drift from the bytes.

There are deliberately no `@deka-0.29.0` dist-tags. This package publishes
through npm trusted publishing (OIDC), and that credential is scoped to
`npm publish` — `npm dist-tag` returns `E401` from CI, both in a later step and
inside the publish step. Restoring dist-tags would mean storing a long-lived
token, which is the thing trusted publishing exists to avoid. Pin an exact
package version from the table instead.

Package semver is independent of the runtime's, so a wrapper fix has somewhere
to go without stealing a version number the runtime will need.

## How releases get here

```
deka release  →  wasm published to R2  →  sync-wasm  →  npm publish  →  consumers
```

`sync-wasm` runs on a `repository_dispatch` from the runtime's release workflow,
on an hourly cron as a backstop, and manually. Every path is idempotent — if the
package already carries the target version, the job does nothing. A release that
is tagged but whose artifacts have not finished uploading exits 2 and is retried
rather than failed, because that race is normal and an alarm that cries wolf gets
muted.

CI refuses to publish if `wasm-info.js` and the committed `.wasm` disagree, so
the package cannot lie about what it carries.

```bash
node scripts/sync-wasm.mjs           # latest release
node scripts/sync-wasm.mjs 0.29.0    # a specific one
node scripts/sync-wasm.mjs --check   # exit 1 if something newer exists
```

## Development

```bash
node --test test/*.test.mjs
```

The tests pin the *contract*, including the negative half: there are assertions
that the compiler still fails to catch invented APIs. If the compiler gets
stricter those tests fail, which is the intended signal to revisit whether
execution is still required — rather than the guarantee quietly narrowing.

## Licence

MIT. Bundles `deka_compiler.wasm`, built from
[dekaruntime/deka](https://github.com/dekaruntime/deka).
`vendor/runtime-globals.mjs` is vendored from that repo's runtime test harness.
