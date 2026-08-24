// Execution is the half that actually validates generated code.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run, check } from '../src/node.js';

test('a working program runs and returns its output', async () => {
  const r = await run('fn main() { console.log("hello"); }\nmain();');
  assert.equal(r.ok, true, r.stderr);
  assert.equal(r.phase, 'ok');
  assert.match(r.stdout, /hello/);
});

test('an invented global is caught at run time', async () => {
  const r = await run('fn main() { totallyMadeUp(); }\nmain();');
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'run');
  assert.match(r.stderr, /totallyMadeUp is not defined/);
});

test('an invented stdlib call is caught at run time', async () => {
  const r = await run('fn main() { deka.http.fetchJSON("x"); }\nmain();');
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'run');
});

test('a syntax error is caught at compile time, before execution', async () => {
  const r = await run('fnc main() { }');
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'compile');
  assert.equal(r.stdout, '');
});

test('bad input never throws -- callers get a verdict', async () => {
  for (const src of ['', '!!!!', 'fn main() { throw 1; }']) {
    const r = await run(src);
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('emitted js is returned even on failure, for inspection', async () => {
  const r = await run('fn main() { totallyMadeUp(); }\nmain();');
  assert.ok(r.js.length > 0);
});

test('a non-terminating program fails rather than hanging the caller', async () => {
  // `while` and `foreach` are not DekaScript, so the runaway case is written
  // with unbounded recursion. It surfaces as a stack overflow rather than a
  // wall-clock timeout, but the contract under test is the same: a bad sample
  // returns a verdict instead of hanging the pipeline.
  const r = await run(
    'fn spin(n: number) number { return spin(n + 1); }\nfn main() { spin(0); }\nmain();',
    { timeoutMs: 500 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'run');
});

test('a for loop runs and prints', async () => {
  const r = await run('fn main() { for (let i = 0; i < 3; i = i + 1) { console.log(i); } }\nmain();');
  assert.equal(r.ok, true, r.stderr);
  assert.match(r.stdout, /0[\s\S]*1[\s\S]*2/);
});

test('check() distinguishes "compiled" from "contributed anything"', async () => {
  const empty = await check('');
  assert.equal(empty.ok, true, 'empty source compiles');
  assert.equal(empty.contributed, false, 'but it contributes nothing');

  const real = await check('fn main() { console.log("x"); }\nmain();');
  assert.equal(real.contributed, true);
});
