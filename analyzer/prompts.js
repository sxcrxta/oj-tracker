// 분석 프롬프트와 출력 형식. 어떤 모델을 쓰든 같은 입력/출력을 쓴다.

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
    const lines = [
      `### 제출 ${i + 1}: ${verdictKo[s.verdict] ?? s.verdict}`,
      `- 시간 ${s.maxTimeMs}ms, 메모리 ${Math.round((s.maxMemoryKb || 0) / 1024)}MB`,
      failed ? `- ${failed.n}번 테스트케이스에서 ${verdictKo[failed.verdict] ?? failed.verdict} (전체 ${p.testcaseCount}개)` : '',
      s.compileOutput ? `- 채점 메시지:\n\`\`\`\n${String(s.compileOutput).slice(0, 1500)}\n\`\`\`` : '',
      '```cpp', s.code, '```',
    ];
    return lines.filter(Boolean).join('\n');
  });
  return `# 문제 #${p.problemId} ${p.title}
시간 제한 ${p.timeLimitMs}ms, 메모리 제한 ${Math.round(p.memoryLimitKb / 1024)}MB, 테스트케이스 ${p.testcaseCount}개

## 문제 설명
${p.statement}

## 예제
${(p.examples || []).map((e, i) => `예제 ${i + 1} 입력:\n${e.input}\n예제 ${i + 1} 출력:\n${e.output}`).join('\n\n')}

## 학생의 제출 기록 (시간 순)
${subs.join('\n\n')}

위 기록을 분석해서 JSON으로 답하라.`;
}

export function overallPrompt(problemResults) {
  const body = problemResults.map(({ problem, result }) => {
    const verdicts = problem.submissions.map((s) => verdictKo[s.verdict] ?? s.verdict).join(' → ');
    return `## #${problem.problemId} ${problem.title}
제출 흐름: ${verdicts}
요약: ${result.summary}
약점: ${result.weak_points.map((w) => `[${w.tag}] ${w.description}`).join(' / ')}
틀린 원인: ${result.attempts.map((a) => `(${a.n}) [${a.tag}] ${a.cause}`).join(' / ')}`;
  });
  return `다음은 한 학생이 여러 문제를 풀면서 틀린 기록을 문제별로 분석한 결과다.
문제들을 가로질러 반복되는 약점을 찾아 종합 리포트를 JSON으로 작성하라.

${body.join('\n\n')}`;
}
