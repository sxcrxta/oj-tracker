// 실행 전용 Worker. 시간 초과면 바깥에서 이 Worker를 통째로 종료한다.
import { runWasm } from './judge-core.js';

let module = null;
self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    module = await WebAssembly.compile(data.wasm);
    self.postMessage({ type: 'loaded' });
  } else if (data.type === 'run') {
    const r = await runWasm(module, data.input);
    self.postMessage({ type: 'result', index: data.index, ...r });
  }
};
