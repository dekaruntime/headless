#!/usr/bin/env node
// Pull a released compiler artifact into the package and regenerate wasm-info.js.
//
//   node scripts/sync-wasm.mjs            # whatever releases.deka.gg calls latest
//   node scripts/sync-wasm.mjs 0.29.0     # a specific release
//   node scripts/sync-wasm.mjs --check    # exit 1 if a newer release exists
//
// This is stage two of the cascade:
//   runtime release -> wasm published -> THIS -> headless published -> worker
//                                                 -> blog draft
//
// Exit codes:
//   0  synced, or already current
//   1  a newer release exists (--check only)
//   2  the release is not fully published yet -- try again later
//   3  something is wrong with the artifact (hash mismatch, bad ABI)

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const RELEASES = 'https://releases.deka.gg';
const WASM = 'https://wasm.deka.gg';

const root = new URL('..', import.meta.url);
const wasmPath = fileURLToPath(new URL('wasm/deka_compiler.wasm', root));
const metaPath = fileURLToPath(new URL('wasm/metadata.json', root));
const infoPath = fileURLToPath(new URL('src/wasm-info.js', root));

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const wanted = args.find((a) => !a.startsWith('-'));

function fail(code, msg, hint) {
  console.error(`\nerror: ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(code);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

const version = wanted ?? (await getJson(`${RELEASES}/latest.json`))?.version;
if (!version) fail(2, `could not determine the latest release from ${RELEASES}/latest.json`);

const current = await currentVersion();
if (current === version && !wanted) {
  console.log(`already on ${version}`);
  process.exit(0);
}

if (checkOnly) {
  console.log(`newer release available: ${current ?? 'none'} -> ${version}`);
  process.exit(1);
}

// The manifest and the wasm must BOTH be published. A release can be tagged
// before its artifacts land, and syncing a half-published release would pin a
// version whose bytes do not exist.
const base = `${WASM}/v${version}`;
const meta = await getJson(`${base}/deka_compiler.wasm.metadata.json`);
if (!meta) {
  fail(2, `no artifact manifest for v${version} at ${base}`,
       'The release may still be publishing. This is a retry, not a failure.');
}

const res = await fetch(`${base}/deka_compiler.wasm`);
if (!res.ok) {
  fail(2, `manifest exists for v${version} but the wasm does not (HTTP ${res.status})`,
       'Half-published release. Retry once the upload completes.');
}
const bytes = new Uint8Array(await res.arrayBuffer());

// Verify before trusting. These bytes get executed on every consumer in the
// cascade, so a silent corruption here propagates all the way to published
// release notes.
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (meta.sha256 && sha256 !== meta.sha256) {
  fail(3, `sha256 mismatch for v${version}`,
       `manifest ${meta.sha256}\n  downloaded ${sha256}`);
}

const embedded = await readEmbeddedMetadata(bytes);

console.log(`v${version}`);
console.log(`  sha256           ${sha256}`);
console.log(`  source commit    ${meta.source_commit ?? 'unknown'}`);
console.log(`  manifest version ${meta.compiler?.version ?? version}`);
console.log(`  embedded version ${embedded?.version ?? 'unknown'}`);
// The bytes are what the compiler IS; the tag is what we MEANT to publish.
// When they disagree the release is bad, and pinning it would defeat the point
// of pinning at all -- a consumer asking "which compiler validated this sample"
// would get an answer that is not true of the bytes. See dekaruntime/deka#279.
if (embedded?.version && meta.compiler?.version && embedded.version !== meta.compiler.version) {
  if (!args.includes('--allow-version-mismatch')) {
    fail(3,
      `v${version} is a bad release: the artifact says ${embedded.version}, the manifest says ${meta.compiler.version}`,
      'The release gate in deka#278 prevents new ones. To pin a known-bad older\n' +
      '  release anyway, re-run with --allow-version-mismatch.');
  }
  console.log(`  WARNING: pinning a known-bad release (deka#279) because --allow-version-mismatch was passed`);
}

await writeFile(wasmPath, bytes);
await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
await writeFile(infoPath, renderInfo({ version, meta, embedded, sha256 }));
console.log(`\nsynced -> wasm/deka_compiler.wasm, src/wasm-info.js`);

async function currentVersion() {
  try {
    const src = await readFile(infoPath, 'utf8');
    return src.match(/manifestVersion:\s*'([^']+)'/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Read the artifact's own idea of its version through the compiler ABI. */
async function readEmbeddedMetadata(bytes) {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const e = instance.exports;
    if (!e.deka_compiler_metadata) return null;
    const ptr = e.deka_compiler_metadata();
    const header = new DataView(e.memory.buffer, ptr, 8);
    const jsonPtr = header.getUint32(0, true);
    const jsonLen = header.getUint32(4, true);
    const json = JSON.parse(new TextDecoder().decode(
      new Uint8Array(e.memory.buffer, jsonPtr, jsonLen)));
    e.deka_compiler_free(ptr, 8 + jsonLen);
    return json;
  } catch (error) {
    fail(3, `v${version} artifact does not instantiate: ${error.message}`,
         'The published bytes are not a usable compiler module.');
  }
}

function renderInfo({ version, meta, embedded, sha256 }) {
  return `// GENERATED by scripts/sync-wasm.mjs -- do not edit by hand.
//
// Two version fields on purpose. The release manifest and the artifact's own
// embedded metadata do not always agree (dekaruntime/deka#279), and this package
// refuses to pick a winner: laundering the two into one number would hide
// exactly the drift that matters when the whole point is knowing which compiler
// validated a piece of code.
//
// \`manifest\` is what the release pipeline published for this file.
// \`embedded\` is what the wasm reports about itself at runtime.
// When they differ, trust \`sha256\` -- it identifies the bytes unambiguously.

export const bundledWasmInfo = Object.freeze({
  manifestVersion: '${meta.compiler?.version ?? version}',
  embeddedVersion: '${embedded?.version ?? 'unknown'}',
  releaseVersion: '${version}',
  sourceCommit: '${meta.source_commit ?? 'unknown'}',
  sha256: '${sha256}',
  target: '${meta.target ?? 'wasm32-unknown-unknown'}',
  abiVersion: ${meta.compiler?.abi_version ?? 1},
  syncedAt: '${new Date().toISOString().slice(0, 10)}',
});

/**
 * The compiler version, as reported by the artifact itself.
 *
 * Deliberately NOT the CDN sidecar or the release tag: the bytes are what the
 * compiler is, the tag is what we meant to publish. When those disagree the tag
 * is the thing that is wrong (deka#279).
 */
export const wasmVersion = bundledWasmInfo.embeddedVersion;

/** The runtime commit the artifact was built from. Unambiguous; prefer it. */
export const wasmSourceCommit = bundledWasmInfo.sourceCommit;
`;
}
