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
