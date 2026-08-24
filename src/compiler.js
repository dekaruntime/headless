// Marshalling for the deka browser compiler's flat C ABI.
//
// The artifact is a bare wasm32-unknown-unknown module with ZERO imports, so it
// instantiates with no import object on any host that has WebAssembly --
// Cloudflare Workers, browsers, Node, Deno, Bun. Nothing in this file touches a
// host API beyond TextEncoder/TextDecoder.
//
// ABI, as exported by crates/deka_compiler_wasm:
//
//   deka_compiler_alloc(len) -> ptr
//   deka_compiler_free(ptr, len)
//   deka_compiler_compile(srcPtr, srcLen, namePtr, nameLen, modePtr, modeLen) -> ptr
//   deka_compiler_format_ds(ptr, len) -> ptr
//   deka_compiler_format_js(ptr, len) -> ptr
//   deka_compiler_metadata() -> ptr
//
// Every "-> ptr" is an 8-byte header of two little-endian u32s: the pointer to a
// UTF-8 JSON payload, and its length.

const ABI_VERSION = 1;

/** Every allocation this module makes is freed, including on the error path. */
class Arena {
  constructor(exports) {
    this.e = exports;
    this.owned = [];
  }

  /** Copy a JS string into wasm memory as UTF-8. */
  write(value) {
    const bytes = new TextEncoder().encode(value);
    const ptr = this.e.deka_compiler_alloc(bytes.length);
    if (!ptr) throw new Error('deka_compiler_alloc returned a null pointer');
    // memory.buffer is re-read on every access: alloc can grow the memory and
    // detach any Uint8Array view taken before the call.
    new Uint8Array(this.e.memory.buffer, ptr, bytes.length).set(bytes);
    this.owned.push([ptr, bytes.length]);
    return [ptr, bytes.length];
  }

  /** Read the {ptr,len} header a compiler entry point returns, and its JSON. */
  readResult(resultPtr) {
    if (!resultPtr) throw new Error('compiler returned a null result pointer');
    const header = new DataView(this.e.memory.buffer, resultPtr, 8);
    const jsonPtr = header.getUint32(0, true);
    const jsonLen = header.getUint32(4, true);
    const text = new TextDecoder().decode(
      new Uint8Array(this.e.memory.buffer, jsonPtr, jsonLen),
    );
    this.owned.push([resultPtr, 8 + jsonLen]);
    return JSON.parse(text);
  }

  release() {
    for (const [ptr, len] of this.owned) this.e.deka_compiler_free(ptr, len);
    this.owned.length = 0;
  }
}

/**
 * Wraps an instantiated compiler module.
 *
 * Instances are stateless between calls, so one Compiler can be reused for the
 * life of a process -- which is the point on a Worker, where instantiating a
 * 6.6MB module per request would dominate the request.
 */
export class Compiler {
  constructor(exports, meta) {
    this.exports = exports;
    this.metadata = meta;
    this.version = meta?.compiler?.version ?? 'unknown';
  }

  #call(fn, ...strings) {
    const arena = new Arena(this.exports);
    try {
      const args = [];
      for (const s of strings) args.push(...arena.write(s));
      return arena.readResult(fn.apply(null, args));
    } finally {
      arena.release();
    }
  }

  /**
   * Compile DekaScript source to JavaScript.
   *
   * Returns { ok, js, diagnostics, stderr }. `ok: false` means the source did
   * not compile -- that is a normal result, not an exception. A thrown error
   * from this method means the compiler itself misbehaved.
   */
  compile(source, { filename = 'snippet.ds', mode = 'deka' } = {}) {
    if (typeof source !== 'string') {
      throw new TypeError(`source must be a string, received ${typeof source}`);
    }
    const res = this.#call(
      this.exports.deka_compiler_compile,
      source,
      filename,
      mode,
    );
    return normalise(res);
  }

  /** Format DekaScript source. Formatting is compile in deka, so this can fail. */
  formatDs(source) {
    return normalise(this.#call(this.exports.deka_compiler_format_ds, source));
  }

  /** Format emitted JavaScript. */
  formatJs(source) {
    return normalise(this.#call(this.exports.deka_compiler_format_js, source));
  }
}

/**
 * The compiler reports failure in several shapes across versions. Collapsing
 * them here means a caller never has to ask which one it got -- and a shape we
 * have not seen surfaces as a diagnostic rather than a silent `ok: true` with
 * no code, which is the failure mode that would quietly publish broken samples.
 */
function normalise(res) {
  const diagnostics = Array.isArray(res?.diagnostics) ? res.diagnostics : [];
  const errors = diagnostics.filter((d) => (d?.severity ?? 'error') === 'error');
  // The compiler returns { output: { code } }. Earlier and later shapes are
  // tolerated so a runtime bump cannot silently yield ok:true with empty code.
  const js = typeof res?.output?.code === 'string' ? res.output.code
    : typeof res?.output === 'string' ? res.output
    : typeof res?.code === 'string' ? res.code
    : typeof res?.js === 'string' ? res.js
    : '';

  let ok = res?.ok !== false && errors.length === 0;
  if (ok && js === '') {
    ok = false;
    diagnostics.push({
      severity: 'error',
      message: 'compiler reported success but emitted no code',
    });
  }

  return {
    ok,
    js,
    diagnostics,
    stderr: (ok ? [] : (errors.length ? errors : diagnostics))
      .map(formatDiagnostic)
      .join('\n'),
    raw: res,
  };
}

function formatDiagnostic(d) {
  if (typeof d === 'string') return d;
  const where = d?.line != null ? `${d.line}:${d.column ?? 0}: ` : '';
  const sev = d?.severity ?? 'error';
  const help = d?.help ? `\n  help: ${d.help}` : '';
  return `${where}${sev}: ${d?.message ?? JSON.stringify(d)}${help}`;
}

/**
 * Instantiate a compiler from wasm bytes or an already-compiled Module.
 *
 * Pass a WebAssembly.Module on Cloudflare Workers, where modules are imported
 * at build time rather than compiled from a buffer at runtime.
 */
export async function instantiate(source) {
  const { instance } = source instanceof WebAssembly.Module
    ? { instance: await WebAssembly.instantiate(source, {}) }
    : await WebAssembly.instantiate(toBytes(source), {});

  const e = instance.exports;
  for (const name of ['memory', 'deka_compiler_alloc', 'deka_compiler_free', 'deka_compiler_compile']) {
    if (!e[name]) throw new Error(`wasm module is missing export "${name}" -- not a deka compiler artifact`);
  }

  let meta = null;
  if (e.deka_compiler_metadata) {
    const arena = new Arena(e);
    try {
      meta = arena.readResult(e.deka_compiler_metadata());
    } finally {
      arena.release();
    }
  }

  const abi = meta?.compiler?.abi_version;
  if (abi != null && abi !== ABI_VERSION) {
    throw new Error(
      `compiler ABI ${abi} is not supported by this package (expects ${ABI_VERSION}). ` +
      `Install the @dekaruntime/headless release matching that runtime.`,
    );
  }

  return new Compiler(e, meta);
}

function toBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new TypeError('expected a WebAssembly.Module, ArrayBuffer, or typed array');
}
