// 문제를 푸는 중에 주는 단계별 힌트. 정답 코드나 완성된 풀이는 절대 주지 않는다.
import { toInput } from './analysis.js';

export const MAX_LEVEL = 3;

export const HINT_SYSTEM = `너는 고등학생의 알고리즘 문제 풀이를 돕는 코치다. 학생이 스스로 풀도록 "약한 힌트"만 준다.

절대 하지 않는 것:
- 코드나 의사코드를 주지 않는다. 한 줄이라도 쓰지 않는다.
- 완성된 풀이나 정답 값을 알려주지 않는다.
- 요청받은 단계보다 앞서 나가지 않는다.

지키는 것:
- 학생이 다음에 무엇을 생각해볼지 한두 걸음만 안내한다.
- 한국어로, 고등학생이 읽기 쉽게 짧게 쓴다 (hint는 3문장 이내).
- 문제에 주어진 조건(입력 크기, 제한)을 근거로 말한다.
- 학생이 이미 맞힌 문제라도 같은 규칙을 지킨다.`;

const LEVELS = {
  1: `1단계(가장 약한 힌트)다. 문제를 어떻게 바라볼지만 짚어준다.
- 문제에서 중요한 관찰이나 되묻게 만드는 질문 하나를 준다.
- 알고리즘 이름(예: DP, 이분 탐색)은 말하지 않는다.`,
  2: `2단계다. 접근 방향을 알려준다.
- 단순한 방법이 왜 부족한지(예: 시간), 어떤 쪽으로 생각을 바꿔야 하는지 알려준다.
- 자료구조나 기법의 성격은 설명하되, 이름은 꼭 필요할 때만 쓴다.
- 구체적인 점화식이나 구현 순서는 주지 않는다.`,
  3: `3단계(가장 강한 힌트)다. 핵심 아이디어를 이름까지 알려준다.
- 어떤 알고리즘·자료구조를 쓰는지, 목표 시간복잡도가 얼마인지 말한다.
- 그래도 코드, 점화식의 완성된 형태, 정답은 주지 않는다. 마지막 조립은 학생 몫으로 남긴다.`,
};

export const LEVEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hint', 'check_yourself'],
  properties: {
    hint: { type: 'string', description: '3문장 이내의 힌트' },
    check_yourself: {
      type: 'array', items: { type: 'string' },
      description: '학생이 스스로 확인해볼 질문 1~2개',
    },
  },
};

export const CODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'look_here', 'verdict_guess'],
  properties: {
    summary: { type: 'string', description: '코드가 어떤 방향으로 풀고 있는지 한 문장' },
    look_here: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['where', 'why'],
        properties: {
          where: { type: 'string', description: '다시 볼 부분 (예: "구간 합을 더하는 반복문", "dp 배열 초기화")' },
          why: { type: 'string', description: '왜 그 부분을 의심해야 하는지. 고친 코드는 쓰지 않는다' },
        },
      },
    },
    verdict_guess: { type: 'string', description: '지금 결과가 왜 나왔을지에 대한 짐작. 확실하지 않으면 그렇다고 쓴다' },
  },
};

function problemBlock(problem, input) {
  const limits = [
    problem?.time_limit_ms ? `시간 제한 ${problem.time_limit_ms}ms` : '',
    problem?.memory_limit_kb ? `메모리 제한 ${Math.round(problem.memory_limit_kb / 1024)}MB` : '',
  ].filter(Boolean).join(', ');
  return `# 문제 #${input.problemId} ${input.title}
${limits}

## 문제 설명
${input.statement}
${problem?.statement_has_images ? '\n(원래 문제에는 그림이 있는데 여기에는 빠져 있다. 그림 내용을 안다고 가정하지 마라.)\n' : ''}
## 예제
${(input.examples || []).map((e, i) => `예제 ${i + 1} 입력:\n${e.input}\n예제 ${i + 1} 출력:\n${e.output ?? ''}`).join('\n\n') || '(없음)'}`;
}

const verdictKo = {
  Accepted: '맞았습니다', WrongAnswer: '틀렸습니다', TimeLimitExceeded: '시간 초과',
  MemoryLimitExceeded: '메모리 초과', RuntimeError: '런타임 에러', CompilationError: '컴파일 에러',
};

// 지금까지의 제출 흐름. 어디까지 왔는지 알려주되, 코드는 넣지 않는다.
function attemptsBlock(submissions) {
  if (!submissions.length) return '학생은 아직 제출한 적이 없다.';
  const flow = submissions.map((s) => {
    const failed = (s.testcase_results || []).find((t) => t.verdict !== 'Accepted');
    return `${verdictKo[s.verdict] ?? s.verdict}${failed ? `(${failed.index + 1}번 케이스)` : ''}`;
  }).join(' → ');
  return `학생의 지금까지 제출 결과: ${flow}`;
}

export function levelPrompt({ problem, submissions, level, previousHints }) {
  const input = toInput(problem, submissions ?? []);
  return `${problemBlock(problem, input)}

## 학생 상황
${attemptsBlock(submissions ?? [])}
${previousHints?.length ? `\n이미 준 힌트 (반복하지 말고 이어서 써라):\n${previousHints.map((h, i) => `${i + 1}단계: ${h}`).join('\n')}` : ''}

## 지금 할 일
${LEVELS[level]}

JSON으로 답하라.`;
}

export function codePrompt({ problem, submissions, code, lastSubmission }) {
  const input = toInput(problem, submissions ?? []);
  const failed = (lastSubmission?.testcase_results || []).find((t) => t.verdict !== 'Accepted');
  return `${problemBlock(problem, input)}

## 학생 상황
${attemptsBlock(submissions ?? [])}
${lastSubmission ? `가장 최근 제출 결과: ${verdictKo[lastSubmission.verdict] ?? lastSubmission.verdict}${failed ? ` (${failed.index + 1}번 테스트케이스에서)` : ''}` : ''}
${lastSubmission?.compile_output ? `채점 메시지:\n\`\`\`\n${String(lastSubmission.compile_output).slice(0, 1500)}\n\`\`\`` : ''}

## 학생이 지금 쓰고 있는 코드
\`\`\`cpp
${code}
\`\`\`

## 지금 할 일
이 코드에서 다시 볼 부분을 1~3군데 짚어준다.
- "어디를, 왜 의심해야 하는지"만 말한다. 고친 코드나 올바른 식은 절대 쓰지 않는다.
- 코드가 맞아 보이면 그렇다고 말하고, 놓치기 쉬운 경계 조건을 확인 질문으로 준다.
- 틀린 테스트케이스의 입력값은 주어지지 않는다. 추측이면 추측이라고 밝힌다.

JSON으로 답하라.`;
}

export function normalizeLevelHint(o) {
  if (!o || typeof o.hint !== 'string') throw new Error('hint가 없는 출력');
  return { hint: o.hint, check_yourself: (o.check_yourself ?? []).map(String).slice(0, 3) };
}

export function normalizeCodeHint(o) {
  if (!o || typeof o.summary !== 'string') throw new Error('summary가 없는 출력');
  return {
    summary: o.summary,
    look_here: (o.look_here ?? []).slice(0, 3).map((x) => ({ where: String(x.where ?? ''), why: String(x.why ?? '') })),
    verdict_guess: String(o.verdict_guess ?? ''),
  };
}
