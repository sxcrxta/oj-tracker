// Claude가 만든 코드(정답, 생성기)를 내 컴퓨터에서 안전하게 돌린다.
// 네이티브로 실행하지 않고 WebAssembly(WASI)로 돌려서 파일이나 네트워크에 접근할 수 없다.
import { Worker } from 'node:worker_threads';
import { compileCpp } from '../dashboard/oj/judge-core.js';

// 컴파일러(약 100MB)는 문제를 만들 때 처음 한 번만 불러온다.
let clang = null;
export async function compile(source) {
  clang ||= import('@yowasp/clang').then((m) => m.runClang);
  return compileCpp(await clang, source);
}

// 채점 사이트보다 넉넉한 스택으로 돌려서, 정답 코드가 재귀 한계에 걸리는지는 따로 확인한다.
export function run(wasm, input, timeoutMs) {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./sandbox-worker.js', import.meta.url), {
      workerData: { wasm, input },
      resourceLimits: { stackSizeMb: 64, maxOldGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => { w.terminate(); resolve({ status: 'timeout' }); }, timeoutMs);
    w.once('message', (r) => { clearTimeout(timer); w.terminate(); resolve(r); });
    w.once('error', (e) => { clearTimeout(timer); resolve({ status: 'runtime_error', message: e.message }); });
  });
}
