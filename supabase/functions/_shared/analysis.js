// 분석 공통 모듈: 프롬프트, 출력 형식, 모델 배정 규칙.
// Supabase Edge Function(Deno)과 로컬 Claude 워커(Node)가 함께 쓰므로 플랫폼 API를 쓰지 않는다.

export const MISTAKE_TAGS = {
  overflow: '자료형 범위(오버플로)',
  boundary: '경계값/인덱스',
  init: '초기화 누락',
  complexity: '시간복잡도',
  io_format: '입출력 형식',
  misread: '문제 조건 오해',
  algorithm: '알고리즘 선택',
  implementation: '구현 실수',
  compile: '컴파일/문법',
  runtime: '런타임(배열 범위, 0 나누기, 재귀 깊이)',
  precision: '실수 정밀도',
  other: '기타',
};
const TAG_IDS = Object.keys(MISTAKE_TAGS);

export const SYSTEM_PROMPT = `너는 고등학생의 알고리즘 문제 풀이를 돕는 코치다.
학생이 온라인 저지에 낸 제출 기록을 보고, 학생이 어디서 왜 틀렸는지 분석한다.

원칙:
- 코드에서 직접 확인할 수 있는 근거만 말한다. 확실하지 않으면 추측이라고 밝히고 confidence를 낮춘다.
- 틀린 테스트케이스의 입력값은 주어지지 않는다. "N번 테스트케이스에서 틀림"이라는 정보만 있다.
- 맞은 제출이 있으면, 틀린 제출과 맞은 제출의 차이에서 원인을 찾는다.
- 모든 설명은 한국어로, 고등학생이 이해할 수 있게 짧고 구체적으로 쓴다.
- 반드시 지정된 JSON 형식으로만 답한다.`;

export const PROBLEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'attempts', 'fix_point', 'weak_points', 'advice', 'confidence'],
  properties: {
    summary: { type: 'string', description: '이 문제에서 무엇 때문에 고생했는지 한두 문장' },
    attempts: {
      type: 'array',
      description: '맞지 않은 제출 각각의 원인 (제출 번호 순)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'cause', 'tag'],
        properties: {
          n: { type: 'integer', description: '제출 번호 (1부터)' },
          cause: { type: 'string', description: '이 제출이 틀린 구체적 원인. 코드의 어느 부분인지 짚는다' },
          tag: { type: 'string', enum: TAG_IDS },
        },
      },
    },
    fix_point: { type: ['string', 'null'], description: '결국 무엇을 고쳐서 맞았는지. 아직 못 풀었으면 null' },
    weak_points: {
      type: 'array',
      description: '이 문제에서 드러난 약점 (1~3개)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tag', 'description'],
        properties: {
          tag: { type: 'string', enum: TAG_IDS },
          description: { type: 'string' },
        },
      },
    },
    advice: { type: 'string', description: '다음에 비슷한 문제를 풀 때 확인할 것' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export const OVERALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'top_weaknesses', 'strengths', 'next_steps'],
  properties: {
    overview: { type: 'string', description: '전체 경향 요약 2~3문장' },
    top_weaknesses: {
      type: 'array',
      description: '가장 중요한 약점부터 최대 4개',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tag', 'title', 'description', 'problems', 'practice'],
        properties: {
          tag: { type: 'string', enum: TAG_IDS },
          title: { type: 'string' },
          description: { type: 'string', description: '어떤 문제들에서 어떤 식으로 반복됐는지' },
          problems: { type: 'array', items: { type: 'string' }, description: '근거가 된 문제 번호' },
          practice: { type: 'string', description: '이 약점을 줄이기 위한 구체적 습관이나 연습' },
        },
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' }, description: '앞으로 할 일 2~4개' },
  },
};

const verdictKo = {
  Accepted: '맞았습니다', WrongAnswer: '틀렸습니다', TimeLimitExceeded: '시간 초과',
  MemoryLimitExceeded: '메모리 초과', RuntimeError: '런타임 에러', CompilationError: '컴파일 에러',
};

export function problemPrompt(p) {
  const subs = p.submissions.map((s, i) => {
    const failed = s.testcases.find((t) => t.verdict !== 'Accepted');
    const same = p.submissions.findIndex((x) => x.code === s.code);
    const lines = [
      `### 제출 ${i + 1}: ${verdictKo[s.verdict] ?? s.verdict}`,
      s.maxTimeMs != null ? `- 시간 ${s.maxTimeMs}ms, 메모리 ${Math.round((s.maxMemoryKb || 0) / 1024)}MB` : '',
      failed ? `- ${failed.n}번 테스트케이스에서 ${verdictKo[failed.verdict] ?? failed.verdict}${p.testcaseCount ? ` (전체 ${p.testcaseCount}개)` : ''}` : '',
      s.compileOutput ? `- 채점 메시지:\n\`\`\`\n${String(s.compileOutput).slice(0, 1500)}\n\`\`\`` : '',
      same !== i ? `- 제출 ${same + 1}과 완전히 같은 코드를 다시 냈다.` : ['```cpp', s.code, '```'].join('\n'),
    ];
    return lines.filter(Boolean).join('\n');
  });
  const limits = [
    p.timeLimitMs != null ? `시간 제한 ${p.timeLimitMs}ms` : '',
    p.memoryLimitKb != null ? `메모리 제한 ${Math.round(p.memoryLimitKb / 1024)}MB` : '',
    p.testcaseCount != null ? `테스트케이스 ${p.testcaseCount}개` : '',
  ].filter(Boolean).join(', ');
  return `# 문제 #${p.problemId} ${p.title}
${limits}

## 문제 설명
${p.statement}
${p.statementHasImages ? '\n(주의: 원래 문제에는 그림이 있는데 여기에는 빠져 있다. 그림에 있던 내용을 안다고 가정하지 마라.)\n' : ''}
## 예제
${(p.examples || []).map((e, i) => `예제 ${i + 1} 입력:\n${e.input}\n예제 ${i + 1} 출력:\n${e.output}`).join('\n\n') || '(없음)'}

## 학생의 제출 기록 (시간 순)
${subs.join('\n\n')}

위 기록을 분석해서 JSON으로 답하라.`;
}

// problemResults: [{ problem: 입력, result: 문제별 분석 }], pending: 아직 분석 못 한 문제 입력들
export function overallPrompt(problemResults, pending = []) {
  const flow = (problem) => problem.submissions.map((s) => verdictKo[s.verdict] ?? s.verdict).join(' → ');
  const body = problemResults.map(({ problem, result }) => `## #${problem.problemId} ${problem.title}
제출 흐름: ${flow(problem)}
요약: ${result.summary}
약점: ${result.weak_points.map((w) => `[${w.tag}] ${w.description}`).join(' / ')}
틀린 원인: ${result.attempts.map((a) => `(${a.n}) [${a.tag}] ${a.cause}`).join(' / ')}`);
  const rest = pending.map((problem) => `- #${problem.problemId} ${problem.title}: ${flow(problem)}`);
  return `다음은 한 학생이 여러 문제를 풀면서 틀린 기록을 문제별로 분석한 결과다.
문제들을 가로질러 반복되는 약점을 찾아 종합 리포트를 JSON으로 작성하라.
problems에는 근거가 된 문제 번호만 숫자로 적는다.

${body.join('\n\n')}
${rest.length ? `\n## 아직 원인을 분석하지 않은 문제 (제출 흐름만 참고, 원인을 추측하지 마라)\n${rest.join('\n')}` : ''}`;
}

// ---------- DB 행 → 분석 입력 ----------

// problems 행과 submissions 행들(시간 순)을 프롬프트 입력 형태로 바꾼다.
export function toInput(problem, submissions, { problemId, title } = {}) {
  return {
    problemId: problem?.problem_id ?? problemId,
    title: problem?.title ?? title ?? submissions[0]?.problem_title ?? '',
    statement: problem?.statement ?? '(문제 설명을 불러오지 못함)',
    statementHasImages: !!problem?.statement_has_images,
    examples: problem?.examples ?? [],
    timeLimitMs: problem?.time_limit_ms ?? null,
    memoryLimitKb: problem?.memory_limit_kb ?? null,
    testcaseCount: problem?.testcase_count ?? null,
    submissions: submissions.map((s) => ({
      id: s.submission_id,
      verdict: s.verdict,
      submittedAt: s.submitted_at,
      maxTimeMs: s.max_time_ms,
      maxMemoryKb: s.max_memory_kb,
      testcases: (s.testcase_results || []).map((t) => ({ n: t.index + 1, verdict: t.verdict, timeMs: t.time_ms })),
      compileOutput: s.compile_output,
      code: s.source_code || '',
    })),
  };
}

// ---------- 모델 배정 ----------

// 공백만 다른 줄은 같은 줄로 보고, 두 코드 사이에 바뀐 줄 수(추가+삭제)를 센다.
export function changedLines(a, b) {
  const x = a.split('\n').map((l) => l.trim()).filter(Boolean);
  const y = b.split('\n').map((l) => l.trim()).filter(Boolean);
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return x.length + y.length - 2 * dp[0][0];
}

export const MAX_SIMPLE_CHANGED_LINES = 10;

// 뼈대만 있는 코드(#include, main, return 0 등)를 빼고 실제 로직 줄 수를 센다.
const BOILERPLATE = /^(#include.*|using namespace std;|int main\(\)\s*\{?|\{|\}|return 0;|ios(_base)?::sync_with_stdio.*|cin\.tie.*|cout\.tie.*)$/;
export function logicLines(code) {
  return code.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => l && !BOILERPLATE.test(l)).length;
}

export const ROUTE_REASONS = {
  first_try: '한 번에 맞힘',
  empty_attempt: '틀린 제출이 빈 코드뿐',
  simple: '맞은 코드와 비교하면 되는 문제',
  unsolved: '아직 못 푼 문제',
  multiple_verdicts: '틀린 종류가 여러 가지',
  big_change: '맞힐 때 코드를 많이 바꿈',
};

// Gemma는 "틀린 코드와 맞은 코드의 작은 차이"를 설명하는 일은 잘하지만,
// 정답이 없거나 원인이 여러 개 겹치면 그럴듯한 오답을 확신 있게 내놓는다(모델 비교 결과).
// 그런 문제는 Claude에게 보낸다.
export function route(input) {
  const subs = input.submissions;
  const firstAc = subs.findIndex((s) => s.verdict === 'Accepted');
  const wrong = subs.filter((s) => s.verdict !== 'Accepted');
  if (wrong.length === 0) return { engine: null, reason: 'first_try' };
  if (firstAc < 0) return { engine: 'claude', reason: 'unsolved' };
  if (new Set(wrong.map((s) => s.verdict)).size > 1) return { engine: 'claude', reason: 'multiple_verdicts' };
  const lastWrong = subs.slice(0, firstAc).reverse().find((s) => s.verdict !== 'Accepted');
  if (!lastWrong) return { engine: null, reason: 'first_try' }; // 맞힌 뒤에 실험 삼아 낸 오답만 있음
  const wrongBefore = subs.slice(0, firstAc).filter((s) => s.verdict !== 'Accepted');
  if (wrongBefore.every((s) => logicLines(s.code) === 0)) return { engine: null, reason: 'empty_attempt' };
  if (changedLines(lastWrong.code, subs[firstAc].code) > MAX_SIMPLE_CHANGED_LINES) {
    return { engine: 'claude', reason: 'big_change' };
  }
  return { engine: 'gemma', reason: 'simple' };
}

// ---------- 출력 검사 ----------

// 모델 출력을 형식에 맞게 다듬는다. 고칠 수 없으면 에러를 던진다.
export function normalizeProblemOutput(o, input) {
  if (!o || typeof o.summary !== 'string') throw new Error('summary가 없는 출력');
  const tag = (t) => (t in MISTAKE_TAGS ? t : 'other');
  return {
    summary: o.summary,
    attempts: (Array.isArray(o.attempts) ? o.attempts : [])
      .filter((a) => Number.isInteger(a.n) && a.n >= 1 && a.n <= input.submissions.length)
      .map((a) => ({ n: a.n, cause: String(a.cause ?? ''), tag: tag(a.tag) })),
    fix_point: o.fix_point ?? null,
    weak_points: (Array.isArray(o.weak_points) ? o.weak_points : []).map((w) => ({ tag: tag(w.tag), description: String(w.description ?? '') })),
    advice: String(o.advice ?? ''),
    confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'medium',
  };
}

export function normalizeOverallOutput(o) {
  if (!o || typeof o.overview !== 'string') throw new Error('overview가 없는 출력');
  return {
    overview: o.overview,
    top_weaknesses: (o.top_weaknesses || []).map((w) => ({
      tag: w.tag in MISTAKE_TAGS ? w.tag : 'other',
      title: String(w.title ?? ''),
      description: String(w.description ?? ''),
      problems: (w.problems || []).map((p) => String(p).replace(/^#/, '')),
      practice: String(w.practice ?? ''),
    })),
    strengths: (o.strengths || []).map(String),
    next_steps: (o.next_steps || []).map(String),
  };
}

// 모델이 코드 블록이나 앞뒤 설명을 붙여도 가장 바깥 JSON 객체만 꺼낸다.
export function parseJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`JSON을 찾지 못함: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

// ---------- 종합 리포트 입력 ----------

// 제출(코드 없이 가능)과 문제별 분석 행들로 종합 리포트 입력을 만든다.
// 각 문제의 가장 최근 분석이 done이면 근거로 쓰고, 아니면 "아직 분석 안 됨"으로 넘긴다.
export function buildOverallInputs(submissionRows, analysisRows) {
  const byProblem = new Map();
  for (const s of submissionRows) {
    const key = `${s.judge}:${s.problem_id}`;
    if (!byProblem.has(key)) byProblem.set(key, []);
    byProblem.get(key).push(s);
  }
  const latest = new Map();
  for (const a of analysisRows) {
    if (a.kind !== 'problem') continue;
    const key = `${a.judge}:${a.problem_id}`;
    if (!latest.has(key) || a.created_at > latest.get(key).created_at) latest.set(key, a);
  }
  const done = [];
  const pending = [];
  for (const [key, subs] of byProblem) {
    subs.sort((x, y) => (x.submitted_at < y.submitted_at ? -1 : 1));
    const input = toInput(null, subs, { problemId: subs[0].problem_id });
    if (route(input).reason === 'first_try') continue;
    const a = latest.get(key);
    if (a?.status === 'done' && a.result) done.push({ problem: input, result: a.result });
    else pending.push(input);
  }
  return { done, pending };
}
