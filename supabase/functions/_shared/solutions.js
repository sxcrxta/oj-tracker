// 정리해 둔 풀이에 이름과 설명을 붙인다. (코드 정리창의 "Claude가 설명 채우기")
import { toInput } from './analysis.js';

export const EXPLAIN_SYSTEM = `너는 고등학생의 알고리즘 코드를 정리해 주는 코치다.
학생이 이미 푼 문제의 풀이 코드를 보고, 나중에 다시 봤을 때 알아보기 쉽게 이름과 설명을 붙인다.

규칙:
- 한국어로, 짧고 분명하게 쓴다.
- title은 풀이 방식을 알아볼 수 있는 이름이다 (예: "탑다운 메모이제이션", "바텀업 DP", "투 포인터", "우선순위 큐 사용").
- approach는 이 코드가 어떻게 푸는지 2~3문장으로 설명한다. 코드를 그대로 옮겨 적지 말고 아이디어를 쓴다.
- complexity는 시간과 공간 복잡도를 "시간 O(N log N), 공간 O(N)" 형식으로 쓴다. 변수 이름은 문제에 나온 것을 쓴다.
- key_points는 이 방식의 장점이나 주의할 점을 1~3개 쓴다 (예: "재귀 깊이가 N까지 간다", "메모리를 덜 쓴다").`;

export const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'approach', 'complexity', 'key_points'],
  properties: {
    title: { type: 'string' },
    approach: { type: 'string' },
    complexity: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
  },
};

export function explainPrompt({ problem, solution, otherSolutions = [] }) {
  const input = toInput(problem, []);
  return `# 문제 #${input.problemId} ${input.title}

## 문제 설명
${input.statement}

## 학생이 정리하려는 풀이 코드
\`\`\`${solution.language ?? 'cpp'}
${solution.code}
\`\`\`
${otherSolutions.length ? `\n## 이 문제에 이미 정리해 둔 다른 풀이\n${otherSolutions.map((s) => `- ${s.title || '(이름 없음)'}: ${s.approach || ''}`).join('\n')}\n(위와 겹치지 않게, 이 코드만의 방식이 드러나는 이름을 지어라.)` : ''}

이 풀이의 이름과 설명을 JSON으로 만들어라.`;
}

export function normalizeExplain(o) {
  if (!o || typeof o.title !== 'string') throw new Error('title이 없는 출력');
  return {
    title: o.title.slice(0, 80),
    approach: String(o.approach ?? ''),
    complexity: String(o.complexity ?? ''),
    key_points: (o.key_points ?? []).map(String).slice(0, 3),
  };
}
