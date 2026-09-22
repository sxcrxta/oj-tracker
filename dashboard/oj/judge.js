// 브라우저 채점 진행: 컴파일 Worker로 컴파일하고, 실행 Worker로 테스트케이스를 하나씩 돌린다.
// 테스트케이스를 모두 통과해야 "맞았습니다". 처음 틀린 케이스에서 멈춘다.
import { sameOutput } from './judge-core.js';

// WebAssembly는 네이티브보다 느리고 측정도 들쭉날쭉해서 시간 제한을 넉넉하게 적용한다.
export const TIME_FACTOR = 2;
const STARTUP_GRACE_MS = 300;

let compiler = null;
function compileWorker() {
  compiler ||= new Worker(new URL('./compile-worker.js', import.meta.url), { type: 'module' });
  return compiler;
}

const mb = (n) => (n / 1048576).toFixed(1);
const progressText = (d) => `컴파일러 받는 중… ${mb(Math.min(d.done, d.total))} / ${mb(d.total)}MB (처음 한 번만)`;

// 문제 페이지를 열자마자 컴파일러를 미리 받아둔다. onProgress(text), 끝나면 onReady().
export function warm(onProgress, onReady) {
  const w = compileWorker();
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') onProgress?.(progressText(data));
    else if (data.type === 'warmed') onReady?.();
    else if (data.type === 'warm-failed') onProgress?.(`컴파일러를 받지 못했어요: ${data.message}`);
  };
  w.postMessage({ type: 'warm' });
}

export function compile(source, onStatus) {
  const w = compileWorker();
  return new Promise((resolve) => {
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') onStatus?.(progressText(data));
      else if (data.type === 'status') onStatus?.(data.text);
      else if (data.type === 'compiled') {
        if (data.internal) compiler = null; // 컴파일러를 못 불러왔으면 다음에 새로 시도
        resolve(data);
      }
    };
    w.postMessage({ type: 'compile', source });
  });
}

function runWorker(wasm) {
  const w = new Worker(new URL('./run-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve) => {
    w.onmessage = ({ data }) => { if (data.type === 'loaded') resolve(w); };
    w.postMessage({ type: 'load', wasm });
  });
}

function runCase(w, index, input, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    w.onmessage = ({ data }) => {
      if (data.type === 'result' && data.index === index) { clearTimeout(timer); resolve(data); }
    };
    w.onerror = (e) => { clearTimeout(timer); resolve({ status: 'runtime_error', message: e.message }); };
    w.postMessage({ type: 'run', index, input });
  });
}

// 반환 형식은 dshs.app 제출 상세와 맞춘다 (submissions 테이블에 그대로 저장).
// keepOutput: 예제 실행처럼 사용자가 자기 출력을 봐야 할 때 출력 앞부분을 결과에 담는다.
export async function judge({ source, testcases, timeLimitMs, memoryLimitKb, onStatus, onCase, keepOutput = false }) {
  const c = await compile(source, onStatus);
  if (!c.ok) {
    return { verdict: c.internal ? 'JudgeError' : 'CompilationError', compileOutput: c.message, results: [], maxTimeMs: 0, maxMemoryKb: 0 };
  }
  onStatus?.('채점 중…');
  let w = await runWorker(c.wasm);
  const results = [];
  let verdict = 'Accepted';
  let note = null;
  const limit = timeLimitMs * TIME_FACTOR;
  try {
    for (let i = 0; i < testcases.length; i++) {
      const tc = testcases[i];
      const r = await runCase(w, i, tc.input, limit + STARTUP_GRACE_MS + 1000);
      let v = 'Accepted';
      if (r.status === 'timeout') {
        v = 'TimeLimitExceeded';
        w.terminate();
        w = null;
      } else if (r.status === 'stack_overflow') {
        v = 'RuntimeError'; note = '재귀가 너무 깊어요 (브라우저 채점은 재귀 깊이에 한계가 있어요)';
      } else if (r.status === 'output_limit') {
        v = 'WrongAnswer'; note = '출력이 너무 많아요';
      } else if (r.status === 'runtime_error') {
        v = 'RuntimeError'; note = r.message || null;
      } else if (r.timeMs > limit) {
        v = 'TimeLimitExceeded';
      } else if (r.memoryKb > memoryLimitKb) {
        v = 'MemoryLimitExceeded';
      } else if (!sameOutput(r.stdout, tc.output)) {
        v = 'WrongAnswer';
      }
      const res = { index: i, verdict: v, time_ms: r.status === 'timeout' ? limit : r.timeMs, memory_kb: r.memoryKb ?? 0 };
      if (keepOutput && r.stdout != null) res.stdout = r.stdout.slice(0, 4000);
      results.push(res);
      onCase?.(res, testcases.length);
      if (v !== 'Accepted') { verdict = v; break; }
    }
  } finally {
    w?.terminate();
  }
  return {
    verdict,
    compileOutput: note,
    results,
    maxTimeMs: Math.max(0, ...results.map((r) => r.time_ms)),
    maxMemoryKb: Math.max(0, ...results.map((r) => r.memory_kb)),
  };
}
