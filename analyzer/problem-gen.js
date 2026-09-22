// Claude로 연습장 문제 만들기.
// Claude는 문제, 정답 코드, (가능하면) 느린 검증용 코드, 테스트 입력 생성기를 쓴다.
// 테스트 출력은 Claude가 쓰지 않고 정답 코드를 실제로 돌려서 만든다.
// 검증용 코드와 정답 코드의 답이 다르거나 코드가 안 돌면, 이유를 알려주고 한 번 더 고치게 한다.
import { compile, run } from './sandbox.js';
import { sameOutput } from '../dashboard/oj/judge-core.js';
import { MISTAKE_TAGS } from './prompts.js';

const MAX_TEST_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 2;

const SYSTEM = `너는 고등학생용 알고리즘 연습 문제를 만드는 출제자다. 결과는 C++17로 채점되는 온라인 저지에 그대로 올라간다.

규칙:
- 모든 글은 한국어. 문제 설명은 마크다운, 수식은 $...$ (KaTeX).
- 문제 설명(statement)에는 이야기와 과제만 쓰고, 입력/출력 형식은 input_spec, output_spec에 따로 쓴다. 입력 범위(제약)는 input_spec에 적는다.
- 정답 코드(solution_cpp)는 의도한 풀이로, 최대 입력에서도 1초 안에 넉넉히 돈다. 재귀 깊이는 10,000을 넘지 않게 한다 (채점기가 브라우저 WebAssembly라 깊은 재귀가 불가능). 예외(try/throw)는 쓰지 않는다.
- brute_cpp는 작은 입력에서만 쓰는, 확실히 맞는 느린 풀이다 (완전 탐색 등). 만들기 어려우면 빈 문자열.
- generator_cpp는 표준 입력으로 "시드와 매개변수" 한 줄을 받아서 테스트 입력 하나를 표준 출력으로 내는 프로그램이다. mt19937(시드)만 쓰고 시간·주소로 난수를 만들지 않는다.
- tests는 10~20개. 경계값, 최소 입력, 특수한 경우, 최대 입력을 섞는다. 직접 쓸 때는 input, 생성기로 만들 때는 gen_input(생성기에 넣을 한 줄)을 쓴다. small은 brute_cpp로 검증할 만큼 작은지 여부다.
- 테스트 하나는 1MB 이하, 전체는 4MB 이하가 되게 입력 크기를 정한다.
- examples는 2~3개의 작은 입력. 출력은 쓰지 않는다 (정답 코드로 만든다).
- 출력이 하나로 정해지는 문제만 낸다 (답이 여러 개 가능한 문제, 실수 오차 비교가 필요한 문제는 피한다).`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'statement', 'input_spec', 'output_spec', 'difficulty', 'tags', 'time_limit_ms', 'memory_limit_mb',
    'examples', 'solution_cpp', 'brute_cpp', 'generator_cpp', 'tests', 'notes'],
  properties: {
    title: { type: 'string' },
    statement: { type: 'string' },
    input_spec: { type: 'string' },
    output_spec: { type: 'string' },
    difficulty: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    time_limit_ms: { type: 'integer' },
    memory_limit_mb: { type: 'integer' },
    examples: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['input'], properties: { input: { type: 'string' } } } },
    solution_cpp: { type: 'string' },
    brute_cpp: { type: 'string' },
    generator_cpp: { type: 'string' },
    tests: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['input', 'gen_input', 'small'],
        properties: {
          input: { type: ['string', 'null'] },
          gen_input: { type: ['string', 'null'] },
          small: { type: 'boolean' },
        },
      },
    },
    notes: { type: 'string', description: '의도한 풀이와 시간복잡도, 흔한 실수' },
  },
};

async function weaknessContext(db) {
  const [overall] = await db('analyses?select=result&kind=eq.overall&status=eq.done&order=created_at.desc&limit=1');
  const rows = await db('analyses?select=result&kind=eq.problem&status=eq.done');
  const counts = {};
  for (const r of rows) for (const a of r.result?.attempts ?? []) counts[a.tag] = (counts[a.tag] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([t, n]) => `${MISTAKE_TAGS[t] ?? t} ${n}회`).join(', ');
  const lines = [];
  if (top) lines.push(`자주 하는 실수 유형: ${top}`);
  if (overall?.result) {
    lines.push(`종합 분석: ${overall.result.overview}`);
    for (const w of overall.result.top_weaknesses ?? []) lines.push(`- 약점 "${w.title}": ${w.description}`);
  }
  return lines.join('\n');
}

function requestPrompt(req, weakness, existingTitles, feedback) {
  return `다음 조건으로 연습 문제 하나를 만들어라.

- 주제: ${req.topic}
- 난이도: ${req.difficulty} (쉬움: 기초 구현/한 가지 아이디어, 보통: 대표 알고리즘 하나를 제대로 적용, 어려움: 아이디어 두 개 이상 또는 까다로운 구현)
${req.notes ? `- 추가 요청: ${req.notes}\n` : ''}${weakness ? `\n학생의 약점 분석 결과다. 이 약점을 연습할 수 있게 만들되, 문제에 약점을 드러내 말하지는 마라.\n${weakness}\n` : ''}
${existingTitles.length ? `이미 있는 문제(겹치지 않게): ${existingTitles.join(', ')}\n` : ''}${feedback ? `\n이전 시도에서 생긴 문제다. 고쳐서 처음부터 다시 전체 JSON을 내라.\n${feedback}\n` : ''}`;
}

// 테스트를 만들고 정답 코드로 검증한다. 문제가 있으면 { error } 로 이유를 돌려준다.
async function buildTests(spec, log) {
  const sol = await compile(spec.solution_cpp);
  if (!sol.ok) return { error: `solution_cpp 컴파일 에러:\n${sol.message}` };
  const gen = spec.tests.some((t) => t.gen_input != null) ? await compile(spec.generator_cpp) : null;
  if (gen && !gen.ok) return { error: `generator_cpp 컴파일 에러:\n${gen.message}` };
  const brute = spec.brute_cpp.trim() ? await compile(spec.brute_cpp) : null;
  if (brute && !brute.ok) return { error: `brute_cpp 컴파일 에러:\n${brute.message}` };

  const timeout = Math.max(spec.time_limit_ms, 1000) * 3;
  const solve = async (input, what) => {
    const r = await run(sol.wasm, input, timeout);
    if (r.status === 'timeout') return { error: `${what}: 정답 코드가 ${timeout}ms 안에 끝나지 않음` };
    if (r.status !== 'ok') return { error: `${what}: 정답 코드 실행 실패 (${r.status} ${r.message ?? ''})` };
    if (r.timeMs > spec.time_limit_ms) return { error: `${what}: 정답 코드가 ${r.timeMs}ms 걸림 (시간 제한 ${spec.time_limit_ms}ms). 더 빠르게 하거나 입력을 줄여라` };
    return { output: r.stdout };
  };

  const examples = [];
  for (const [i, e] of spec.examples.entries()) {
    const s = await solve(e.input, `예제 ${i + 1}`);
    if (s.error) return s;
    examples.push({ input: e.input, output: s.output });
  }

  const tests = [];
  let total = 0;
  for (const [i, t] of spec.tests.entries()) {
    let input = t.input;
    if (input == null) {
      const g = await run(gen.wasm, `${t.gen_input}\n`, 10_000);
      if (g.status !== 'ok') return { error: `테스트 ${i + 1}: 생성기 실행 실패 (${g.status} ${g.message ?? ''}), gen_input="${t.gen_input}"` };
      input = g.stdout;
    }
    const bytes = new TextEncoder().encode(input).length;
    if (bytes > MAX_TEST_BYTES) return { error: `테스트 ${i + 1}: 입력이 ${bytes}바이트로 1MB를 넘음` };
    total += bytes;
    const s = await solve(input, `테스트 ${i + 1}`);
    if (s.error) return s;
    if (brute && t.small) {
      const b = await run(brute.wasm, input, 10_000);
      if (b.status === 'ok' && !sameOutput(b.stdout, s.output)) {
        return { error: `테스트 ${i + 1}: 정답 코드와 brute_cpp의 답이 다름.\n입력:\n${input.slice(0, 500)}\n정답 코드 출력:\n${s.output.slice(0, 300)}\nbrute 출력:\n${b.stdout.slice(0, 300)}` };
      }
    }
    tests.push({ input, output: s.output });
  }
  if (total > MAX_TOTAL_BYTES) return { error: `테스트 입력 전체가 ${total}바이트로 4MB를 넘음` };
  log(`  테스트 ${tests.length}개 생성 (${Math.round(total / 1024)}KB)${brute ? ', brute로 작은 케이스 검증' : ''}`);
  return { examples, tests };
}

// job: oj_problem_jobs 행. analyze: claudeCli().analyze. db: PostgREST 호출 함수.
export async function generateProblem(job, { analyze, db, log }) {
  const req = job.request;
  const weakness = req.use_weakness ? await weaknessContext(db) : '';
  const existing = (await db('oj_problems?select=title&order=id.desc&limit=50')).map((p) => p.title);

  let feedback = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`  Claude에게 출제 요청 (${attempt}번째)`);
    const { output: spec } = await analyze({ system: SYSTEM, prompt: requestPrompt(req, weakness, existing, feedback), schema: SCHEMA });
    const built = await buildTests(spec, log);
    if (built.error) {
      log(`  검증 실패: ${built.error.split('\n')[0]}`);
      feedback = built.error;
      continue;
    }
    const [problem] = await db('oj_problems', {
      method: 'POST', prefer: 'return=representation',
      body: {
        title: spec.title, statement: spec.statement, input_spec: spec.input_spec, output_spec: spec.output_spec,
        examples: built.examples, time_limit_ms: spec.time_limit_ms,
        memory_limit_kb: Math.max(16, spec.memory_limit_mb) * 1024, difficulty: spec.difficulty || req.difficulty,
        tags: spec.tags, source: 'claude', published: false,
      },
    });
    await db('oj_testcases', {
      method: 'POST', prefer: 'return=minimal',
      body: built.tests.map((t, i) => ({ problem_id: problem.id, idx: i, input: t.input, output: t.output })),
    });
    await db('oj_problem_private', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        problem_id: problem.id, solution_code: spec.solution_cpp, generator_code: spec.generator_cpp,
        notes: `${spec.notes}${spec.brute_cpp.trim() ? `\n\n[검증용 느린 풀이]\n${spec.brute_cpp}` : ''}`,
      },
    });
    return problem.id;
  }
  throw new Error(`검증을 통과하지 못했어요: ${feedback.split('\n')[0]}`);
}
