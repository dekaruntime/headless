// What the compiler catches, pinned as tests.
//
// These are not "does it work" tests. They are the contract the release-notes
// pipeline depends on: compiling catches syntax and NOT MUCH ELSE, so anything
// validating generated code has to execute it. If a runtime bump makes the
// compiler stricter these tests fail loudly, which is the signal to revisit
// whether execution is still required.

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { load } from '../src/node.js';
import { bundledWasmInfo } from '../src/wasm-info.js';

let deka;
before(async () => { deka = await load(); });

test('the bundled artifact instantiates and reports metadata', () => {
  assert.ok(deka.metadata, 'no embedded metadata');
  assert.equal(deka.metadata.version, bundledWasmInfo.embeddedVersion,
    'wasm-info.js is stale relative to the bundled wasm -- re-run sync-wasm.mjs');
});

test('valid source compiles', () => {
  const r = deka.compile('fn add(a: number, b: number) number { return a + b; }');
  assert.equal(r.ok, true, r.stderr);
  assert.ok(r.js.length > 0);
  assert.equal(r.diagnostics.length, 0);
});

test('syntax errors are rejected with diagnostics', () => {
  const r = deka.compile('fnc main() { }');
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.length > 0);
  assert.ok(r.stderr.length > 0, 'a failure must carry a readable message');
});

test('a failed compile emits no code', () => {
  assert.equal(deka.compile('fn add(a: number {{{ !!!').js, '');
});

test('compiling does NOT catch invented APIs -- this is why run() exists', () => {
  // If any of these start failing, the compiler got stricter. Good news, but
  // the pipeline's assumptions need rechecking rather than silently narrowing.
  for (const src of [
    'fn main() { totallyMadeUp(); }',
    'fn main() { deka.http.fetchJSON("x"); }',
    'fn add(a: number) number { return a; }\nfn main() { add(1,2,3); }',
  ]) {
    assert.equal(deka.compile(src).ok, true,
      `compiler now rejects "${src}" -- revisit the validation strategy`);
  }
});

test('empty source still emits a prelude, so "has output" is not validation', () => {
  const r = deka.compile('');
  assert.equal(r.ok, true);
  assert.ok(r.js.length > 0, 'expected the prelude');
});

test('compile is deterministic', () => {
  const src = 'fn main() { console.log("x"); }';
  assert.equal(deka.compile(src).js, deka.compile(src).js);
});

test('non-string source is a programmer error, not a result', () => {
  assert.throws(() => deka.compile(null), TypeError);
  assert.throws(() => deka.compile(42), TypeError);
});

test('a non-compiler wasm module is rejected by name', async () => {
  const { instantiate } = await import('../src/compiler.js');
  // (module (memory (export "memory") 1))
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x05, 0x03, 0x01, 0x00, 0x01,
    0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
  ]);
  await assert.rejects(() => instantiate(bytes), /not a deka compiler artifact/);
});
