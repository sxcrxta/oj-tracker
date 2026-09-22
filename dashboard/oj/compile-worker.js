// 컴파일 전용 Worker. 컴파일러(약 23MB)를 한 번 받아두고 계속 쓴다.
import { CLANG_URL, CLANG_FILES, compileCpp } from './judge-core.js';

let ready = null;

// 컴파일러 파일을 먼저 직접 받아서 진행 상황을 보여준다.
// 받은 파일은 브라우저 캐시에 남으므로, 뒤이어 컴파일러가 같은 주소를 요청하면 캐시에서 바로 읽는다.
async function prefetch() {
  const base = CLANG_URL.slice(0, CLANG_URL.lastIndexOf('/') + 1);
  const total = CLANG_FILES.reduce((n, f) => n + f.bytes, 0);
  let done = 0;
  let lastPost = 0;
  const report = (force) => {
    if (!force && Date.now() - lastPost < 300) return;
    lastPost = Date.now();
    self.postMessage({ type: 'progress', done, total });
  };
  report(true);
  await Promise.all(CLANG_FILES.map(async (f) => {
    const res = await fetch(base + f.name);
    if (!res.ok) throw new Error(`${f.name} ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      done += value.length; // 압축된 크기라 대략적인 값
      report(false);
    }
  }));
  done = total;
  report(true);
  return (await import(CLANG_URL)).runClang;
}

function load() {
  ready ||= prefetch().catch((e) => { ready = null; throw e; });
  return ready;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'warm') {
    load().then(() => self.postMessage({ type: 'warmed' }), (e) => self.postMessage({ type: 'warm-failed', message: e.message }));
    return;
  }
  try {
    const runClang = await load();
    self.postMessage({ type: 'status', text: '컴파일 중…' });
    const result = await compileCpp(runClang, data.source);
    self.postMessage({ type: 'compiled', ...result }, result.wasm ? [result.wasm.buffer] : []);
  } catch (e) {
    self.postMessage({ type: 'compiled', ok: false, message: `컴파일러를 불러오지 못했어요: ${e.message}`, internal: true });
  }
};
