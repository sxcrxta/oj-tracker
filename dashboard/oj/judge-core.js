// 채점 핵심: C++ 컴파일(YoWASP clang, WebAssembly)과 WASI 프로그램 실행, 출력 비교.
// 브라우저(연습장 채점)와 Node(Claude 워커의 문제 생성)가 똑같이 쓴다. 플랫폼 API는 쓰지 않는다.

export const CLANG_VERSION = '22.0.0-git20542-10';
export const CLANG_URL = `https://cdn.jsdelivr.net/npm/@yowasp/clang@${CLANG_VERSION}/gen/bundle.js`;
// 컴파일러가 처음 실행될 때 받는 파일들 (bytes는 jsDelivr가 압축해서 보내는 대략적인 크기)
export const CLANG_FILES = [
  { name: 'llvm.core.wasm', bytes: 19_446_983 },
  { name: 'llvm-resources.tar', bytes: 3_595_593 },
  { name: 'llvm.core2.wasm', bytes: 20_000 },
  { name: 'llvm.core3.wasm', bytes: 3_000 },
  { name: 'llvm.core4.wasm', bytes: 800 },
];
export const LINEAR_STACK_BYTES = 32 * 1024 * 1024; // 지역 배열용 스택 (재귀 깊이 한계는 브라우저 호출 스택이 정한다)

// libc++에는 bits/stdc++.h가 없어서 자주 쓰는 표준 헤더를 모아 만든다.
const STDCPP = [
  'cassert', 'cctype', 'cfloat', 'climits', 'cmath', 'cstdio', 'cstdlib', 'cstring', 'ctime', 'cstdint',
  'algorithm', 'array', 'bitset', 'deque', 'functional', 'iomanip', 'iostream', 'iterator', 'limits', 'list',
  'map', 'numeric', 'queue', 'set', 'sstream', 'stack', 'string', 'tuple', 'unordered_map', 'unordered_set',
  'utility', 'vector', 'complex', 'random', 'chrono', 'optional', 'variant', 'string_view', 'memory', 'cstddef',
].map((h) => `#include <${h}>`).join('\n');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// runClang: @yowasp/clang의 runClang. 성공하면 { ok: true, wasm }, 실패하면 { ok: false, message }.
export async function compileCpp(runClang, source) {
  let stderr = '';
  const options = { stderr: (bytes) => { if (bytes) stderr += decoder.decode(bytes); } };
  try {
    const out = await runClang([
      'clang++', '-O2', '-std=c++17', '-fno-exceptions', '-Wno-everything', '-Iinc',
      'main.cpp', '-o', 'main.wasm', `-Wl,-z,stack-size=${LINEAR_STACK_BYTES}`,
    ], { 'main.cpp': source, inc: { bits: { 'stdc++.h': `#pragma once\n${STDCPP}\n` } } }, options);
    return { ok: true, wasm: out['main.wasm'] };
  } catch (e) {
    const message = (stderr || e.message || '').replace(/^.*?main\.cpp:/gm, 'main.cpp:').trim();
    return { ok: false, message: message.slice(0, 4000) || '컴파일 에러' };
  }
}

class ProcExit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

// 최소한의 WASI preview1 구현: 표준 입력/출력/에러와 시계만 있다. 파일 시스템이나 네트워크는 없다.
function makeWasi(stdinBytes, limits) {
  let memory = null;
  let inPos = 0;
  const out = [];
  let outLen = 0;
  const err = [];
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const ENOSYS = 52; const EBADF = 8; const ESUCCESS = 0;

  const imports = {
    args_sizes_get: (argc, bufSize) => { view().setUint32(argc, 0, true); view().setUint32(bufSize, 0, true); return ESUCCESS; },
    args_get: () => ESUCCESS,
    environ_sizes_get: (count, bufSize) => { view().setUint32(count, 0, true); view().setUint32(bufSize, 0, true); return ESUCCESS; },
    environ_get: () => ESUCCESS,
    clock_time_get: (_id, _precision, time) => {
      view().setBigUint64(time, BigInt(Math.round(performance.now() * 1e6)), true); return ESUCCESS;
    },
    clock_res_get: (_id, res) => { view().setBigUint64(res, 1000n, true); return ESUCCESS; },
    random_get: (buf, len) => { crypto.getRandomValues(bytes().subarray(buf, buf + len)); return ESUCCESS; },
    fd_read: (fd, iovs, iovsLen, nread) => {
      if (fd !== 0) return EBADF;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        const chunk = stdinBytes.subarray(inPos, inPos + len);
        bytes().set(chunk, ptr);
        inPos += chunk.length; total += chunk.length;
        if (chunk.length < len) break;
      }
      view().setUint32(nread, total, true);
      return ESUCCESS;
    },
    fd_write: (fd, iovs, iovsLen, nwritten) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        const chunk = bytes().slice(ptr, ptr + len);
        if (fd === 1) {
          outLen += len;
          if (outLen > limits.maxOutputBytes) throw new Error('OUTPUT_LIMIT');
          out.push(chunk);
        } else if (err.length < 64) err.push(chunk);
        total += len;
      }
      view().setUint32(nwritten, total, true);
      return ESUCCESS;
    },
    fd_close: () => ESUCCESS,
    fd_seek: () => ENOSYS,
    fd_fdstat_get: (fd, stat) => {
      if (fd > 2) return EBADF;
      view().setUint8(stat, 2); // character device
      view().setUint16(stat + 2, 0, true);
      view().setBigUint64(stat + 8, 0n, true);
      view().setBigUint64(stat + 16, 0n, true);
      return ESUCCESS;
    },
    fd_fdstat_set_flags: () => ESUCCESS,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    path_open: () => ENOSYS,
    poll_oneoff: () => ENOSYS,
    sched_yield: () => ESUCCESS,
    proc_exit: (code) => { throw new ProcExit(code); },
  };
  // 나머지 함수는 "지원 안 함"으로 답한다.
  const wasi = new Proxy(imports, { get: (t, k) => t[k] ?? (() => ENOSYS) });
  return {
    wasi,
    bind: (m) => { memory = m; },
    stdout: () => {
      const all = new Uint8Array(outLen);
      let o = 0;
      for (const c of out) { all.set(c, o); o += c.length; }
      return decoder.decode(all);
    },
    stderr: () => err.map((c) => decoder.decode(c)).join(''),
  };
}

// 컴파일된 모듈을 입력 하나로 실행한다. 시간 초과는 호출하는 쪽(Worker 종료)에서 처리한다.
// 반환: { status: 'ok' | 'runtime_error' | 'stack_overflow' | 'output_limit', stdout, exitCode, timeMs, memoryKb, message }
export async function runWasm(module, input, { maxOutputBytes = 64 * 1024 * 1024 } = {}) {
  const w = makeWasi(typeof input === 'string' ? encoder.encode(input) : input, { maxOutputBytes });
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: w.wasi });
  const memory = instance.exports.memory;
  w.bind(memory);
  const started = performance.now();
  let status = 'ok';
  let exitCode = 0;
  let message = '';
  try {
    instance.exports._start();
  } catch (e) {
    if (e instanceof ProcExit) exitCode = e.code;
    else if (e instanceof RangeError && /call stack/i.test(e.message)) status = 'stack_overflow';
    else if (e?.message === 'OUTPUT_LIMIT') status = 'output_limit';
    else { status = 'runtime_error'; message = String(e?.message ?? e); }
  }
  const timeMs = Math.round(performance.now() - started);
  if (status === 'ok' && exitCode !== 0) { status = 'runtime_error'; message = `프로그램이 ${exitCode}을(를) 반환하며 끝남`; }
  const memoryKb = Math.max(0, Math.round((memory.buffer.byteLength - LINEAR_STACK_BYTES) / 1024));
  return { status, stdout: w.stdout(), stderr: w.stderr(), exitCode, timeMs, memoryKb, message };
}

// 줄 끝 공백과 마지막 빈 줄은 무시하고 비교한다.
export function sameOutput(actual, expected) {
  const norm = (s) => s.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  return norm(actual) === norm(expected);
}
