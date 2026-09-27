// 문제 지도의 "Claude로 정리": 아직 분류 안 된 문제에 분류를 붙이고, 다른 문제와의 연결을 찾는다.

// 분류는 이 목록에서만 고른다. 지도에서 비슷한 이름이 여러 개 생기지 않게 하려는 것.
export const MAP_CATEGORIES = [
  'DP', '정렬', '그리디', '이분 탐색', '누적 합', '투 포인터', '브루트포스', '백트래킹', '분할 정복',
  '스택/큐', '자료구조', '그래프 탐색', '최단 경로', '트리', '문자열', '수학', '구현',
];

export const MAP_SYSTEM = `너는 고등학생이 푼 알고리즘 문제들을 주제별로 정리해 주는 코치다.
각 문제에 분류 하나를 붙이고, 다른 문제와 뚜렷하게 이어지는 관계가 있으면 연결을 만든다.

분류 규칙:
- category는 반드시 다음 중 하나: ${MAP_CATEGORIES.join(', ')}
- 문제를 푸는 데 쓰는 핵심 아이디어로 고른다. 문제 이야기(소재)가 아니라 풀이 방법이 기준이다.
  예: 정렬 기준을 직접 정하는 문제는 "정렬", 점화식을 세우는 문제는 "DP", 스택으로 식을 계산하는 문제는 "스택/큐".
- 학생의 코드가 있으면 참고하되, 코드가 돌아가는 방식보다 문제가 요구하는 아이디어를 우선한다.
- 특별한 알고리즘 없이 시키는 대로 하면 되는 문제는 "구현".

연결 규칙:
- 연결 대상은 주어진 "전체 문제 목록"에 있는 key만 쓴다. 자기 자신과는 잇지 않는다.
- relation은 셋 중 하나:
  - "harder_than": 이 문제가 상대 문제의 확장 버전이다 (같은 아이디어에 조건이 더해지거나 더 어려워짐)
  - "easier_than": 이 문제가 상대 문제의 기본 버전이다
  - "similar": 같은 아이디어를 쓰는 비슷한 문제다
- 확실한 관계만 만든다. 분류가 같다는 이유만으로 잇지 않는다. 한 문제에 연결은 0~3개.
- note에는 왜 이어지는지 한 문장 (예: "N 범위가 커져서 O(N log N)이 필요하다").`;

export const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'category', 'links'],
        properties: {
          key: { type: 'string' },
          category: { type: 'string', enum: MAP_CATEGORIES },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['to', 'relation', 'note'],
              properties: {
                to: { type: 'string' },
                relation: { type: 'string', enum: ['harder_than', 'easier_than', 'similar'] },
                note: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}\n…(생략)` : t;
};

// targets: [{ key, title, statement, code }]  all: [{ key, title, category }]
export function mapPrompt({ targets, all }) {
  const list = all.map((p) => `- ${p.key} ${p.title || '(제목 없음)'}${p.category ? ` [${p.category}]` : ''}`).join('\n');
  const body = targets.map((t) => `### ${t.key} ${t.title || '(제목 없음)'}

${t.statement ? `문제 설명:\n${clip(t.statement, 1500)}` : '(문제 설명이 저장돼 있지 않다. 제목과 코드로 판단한다.)'}
${t.code ? `\n학생 코드:\n\`\`\`cpp\n${clip(t.code, 2500)}\n\`\`\`` : ''}`).join('\n\n');
  return `# 전체 문제 목록 (key 제목 [분류])
${list}

# 이번에 정리할 문제 ${targets.length}개
${body}

위 ${targets.length}개 문제 각각에 대해 items에 하나씩, key를 그대로 써서 JSON으로 답하라.`;
}

// Claude 출력 → 저장할 분류와 연결. 목록에 없는 key나 자기 자신 연결은 버린다.
export function normalizeMap(output, { targets, all }) {
  const targetKeys = new Set(targets.map((t) => t.key));
  const allByKey = new Map(all.map((p) => [p.key, p]));
  const categories = [];
  const links = [];
  for (const item of output?.items ?? []) {
    if (!targetKeys.has(item.key) || !MAP_CATEGORIES.includes(item.category)) continue;
    categories.push({ key: item.key, category: item.category });
    for (const l of (item.links ?? []).slice(0, 3)) {
      if (l.to === item.key || !allByKey.has(l.to)) continue;
      // 확장 관계는 쉬운 쪽 → 어려운 쪽(extends) 한 방향으로만 저장한다.
      const [from, to] = l.relation === 'easier_than' ? [item.key, l.to] : [l.to, item.key];
      const kind = l.relation === 'similar' ? 'similar' : 'extends';
      const [a, b] = kind === 'similar' ? [item.key, l.to] : [from, to];
      links.push({ from: a, to: b, kind, note: String(l.note ?? '').slice(0, 200) });
    }
  }
  return { categories, links };
}
