// worker_threads 안에서 WebAssembly 프로그램 하나를 실행한다 (sandbox.js가 띄운다).
import { parentPort, workerData } from 'node:worker_threads';
import { runWasm } from '../dashboard/oj/judge-core.js';

const module = await WebAssembly.compile(workerData.wasm);
parentPort.postMessage(await runWasm(module, workerData.input));
