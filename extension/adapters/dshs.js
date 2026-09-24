// dshs.app 온라인 저지 어댑터.
// 다른 채점 사이트를 추가할 때는 같은 모양의 객체를 adapters/에 만들고
// manifest.json의 content_scripts에 등록하면 된다.
//
// 어댑터가 제공해야 하는 것:
//   judge                 저장 시 구분용 사이트 이름
//   matches(location)     이 페이지에서 동작하는지
//   listSources(location) 내 제출 목록을 읽을 곳들 [{ listUrl(page), detailUrl(id), contestId }]
//   isFinal(item)         채점이 끝났는지
//   toRecord(detail, src) DB에 저장할 공통 형식으로 변환
(() => {
  const PENDING = new Set(['pending', 'queued', 'waiting', 'running', 'judging', 'grading']);

  const adapter = {
    judge: 'dshs',

    matches: (loc) => loc.hostname === 'dshs.app' && loc.pathname.startsWith('/oj'),

    listSources(loc) {
      const sources = [{
        contestId: null,
        listUrl: (page) => `/api/oj/submissions?mine=1&page=${page}`,
        detailUrl: (id) => `/api/oj/submissions/${encodeURIComponent(id)}`,
      }];
      const m = loc.pathname.match(/^\/oj\/contests\/([^/]+)/);
      if (m) {
        const base = `/api/oj/contests/${encodeURIComponent(m[1])}/submissions`;
        sources.push({
          contestId: decodeURIComponent(m[1]),
          listUrl: (page) => `${base}?mine=1&page=${page}`,
          detailUrl: (id) => `${base}/${encodeURIComponent(id)}`,
        });
      }
      return sources;
    },

    itemId: (item) => item.id,
    itemTime: (item) => Date.parse(item.createdAt),
    isMine: (item) => item.mine !== false,
    isFinal: (item) => !!item.status && !PENDING.has(item.status) && !!item.verdict,

    problemId: (item) => String(item.problemId),
    // 지금 보고 있는 문제 (힌트와 문제 저장에 쓴다)
    currentProblemId: (loc) => loc.pathname.match(/^\/oj\/problem\/(\d+)/)?.[1] ?? null,
    // 편집기에 쓰고 있는 코드 (CodeMirror 6)
    currentCode: () => document.querySelector('.cm-content')?.innerText ?? '',
    problemUrl: (id) => `/api/oj/problems/${encodeURIComponent(id)}`,

    // 문제 설명은 서식 있는 문서(ProseMirror JSON)라 글자만 뽑는다. 그림은 옮길 수 없어서 있다는 표시만 남긴다.
    toProblem(d) {
      let hasImages = false;
      const text = (n) => {
        if (!n) return '';
        if (n.type === 'text') return n.text || '';
        if (n.type === 'image') { hasImages = true; return '[그림]'; }
        const latex = n.attrs?.latex ?? (n.content ? null : n.attrs?.content);
        if (latex) return `$${latex}$`;
        const inner = (n.content || []).map(text).join('');
        return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type) ? `${inner}\n` : inner;
      };
      const statement = typeof d.statement === 'string' ? d.statement : text(d.statement).trim();
      return {
        judge: 'dshs',
        problem_id: String(d.id),
        title: d.title ?? null,
        statement,
        statement_has_images: hasImages || (d.statementFiles?.length ?? 0) > 0,
        examples: (d.examples || []).map((e) => ({ input: e.input, output: e.output })),
        time_limit_ms: d.timeLimitMs ?? null,
        memory_limit_kb: d.memoryLimitKb ?? null,
        testcase_count: d.testcaseCount ?? null,
        tags: d.tags || [],
      };
    },

    toRecord(d, src) {
      const tcs = Array.isArray(d.testcaseResults) ? d.testcaseResults : [];
      const failed = tcs.find((t) => t.verdict && t.verdict !== 'Accepted');
      const { user, ...rest } = d; // 이메일 등 개인정보는 저장하지 않는다
      return {
        judge: 'dshs',
        submission_id: String(d.id),
        judge_user_id: user?.id ?? null,
        problem_id: String(d.problemId),
        problem_title: d.problemTitle ?? null,
        contest_id: src.contestId,
        language: d.language ?? null,
        status: d.status ?? null,
        verdict: d.verdict ?? null,
        max_time_ms: d.maxTimeMs ?? null,
        max_memory_kb: d.maxMemoryKb ?? null,
        score: d.score ?? null,
        max_score: d.maxScore ?? null,
        source_code: d.sourceCode ?? null,
        compile_output: d.compileOutput == null ? null
          : typeof d.compileOutput === 'string' ? d.compileOutput : JSON.stringify(d.compileOutput),
        testcase_results: tcs,
        failed_testcase: failed ? failed.index + 1 : null,
        submitted_at: d.createdAt,
        raw: rest,
      };
    },
  };

  // 다시 주입될 때 같은 어댑터가 두 번 등록되지 않게 교체한다.
  globalThis.OJ_ADAPTERS = [...(globalThis.OJ_ADAPTERS || []).filter((a) => a.judge !== adapter.judge), adapter];
})();
