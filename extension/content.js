// 채점 사이트 페이지 안에서 돌면서, 새로 채점이 끝난 내 제출을 찾아 background로 보낸다.
// 사이트 API는 로그인 쿠키가 필요하므로 페이지와 같은 출처인 content script에서 호출한다.
(() => {
  // 확장 프로그램을 설치/업데이트하면 열려 있던 탭에도 다시 주입된다.
  // 이전 인스턴스가 아직 살아 있으면 중복 실행하지 않는다.
  const alive = () => !!chrome.runtime?.id;
  if (globalThis.__OJ_TRACKER__?.alive()) return;
  globalThis.__OJ_TRACKER__ = { alive };

  const adapters = globalThis.OJ_ADAPTERS || [];
  const MAX_PAGES = 5;
  const BURST_INTERVAL_MS = 3000;
  const BURST_MIN_MS = 20000;
  const BURST_MAX_MS = 5 * 60 * 1000;
  const IDLE_INTERVAL_MS = 60000;

  let running = null;
  let burstTimer = null;

  const getJson = async (url) => {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  };

  const syncedKey = (judge, id) => `${judge}:${id}`;

  // 새로 저장한 개수와 아직 채점 중인 제출이 있는지 돌려준다.
  async function syncOnce() {
    const adapter = adapters.find((a) => a.matches(location));
    if (!adapter) return { saved: 0, pending: false };

    const { session, trackingSince, synced = {}, problemsSaved = {} } =
      await chrome.storage.local.get(['session', 'trackingSince', 'synced', 'problemsSaved']);
    if (!session || !trackingSince) return { saved: 0, pending: false };

    let saved = 0;
    let pending = false;
    const seen = new Set();
    const problemIds = new Set();

    for (const src of adapter.listSources(location)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        let list;
        try {
          list = await getJson(src.listUrl(page));
        } catch {
          break; // 이 페이지에서 지원하지 않는 목록이면 넘어간다
        }
        const items = list.items || [];
        let reachedOld = items.length === 0;

        for (const item of items) {
          const id = adapter.itemId(item);
          if (adapter.itemTime(item) < trackingSince) { reachedOld = true; continue; }
          if (adapter.isMine(item)) problemIds.add(adapter.problemId(item));
          if (!adapter.isMine(item) || seen.has(id) || synced[syncedKey(adapter.judge, id)]) continue;
          seen.add(id);
          if (!adapter.isFinal(item)) { pending = true; continue; }

          try {
            const detail = await getJson(src.detailUrl(id));
            const record = adapter.toRecord(detail, src);
            const res = await chrome.runtime.sendMessage({ type: 'save', record });
            if (res?.ok) saved++;
          } catch (e) {
            console.warn('[OJ 기록기] 저장 실패', id, e);
          }
        }
        const lastPage = !list.total || !list.pageSize || page * list.pageSize >= list.total;
        if (reachedOld || lastPage) break;
      }
    }
    await saveProblems(adapter, problemIds, problemsSaved);
    return { saved, pending };
  }

  // 분석에 쓸 문제 설명을 저장한다. 문제 내용이 바뀔 수 있어서 일주일마다 다시 받는다.
  const PROBLEM_REFRESH_MS = 7 * 24 * 3600 * 1000;
  async function saveProblems(adapter, ids, problemsSaved) {
    for (const id of ids) {
      const key = `${adapter.judge}:${id}`;
      if (Date.now() - (problemsSaved[key] || 0) < PROBLEM_REFRESH_MS) continue;
      try {
        const problem = adapter.toProblem(await getJson(adapter.problemUrl(id)));
        await chrome.runtime.sendMessage({ type: 'saveProblem', problem });
      } catch (e) {
        console.warn('[OJ 기록기] 문제 저장 실패', id, e);
      }
    }
  }

  function sync() {
    if (!alive()) { // 확장 프로그램이 새로 로드되면 이 인스턴스는 멈춘다
      clearInterval(idleTimer);
      clearTimeout(burstTimer);
      return Promise.resolve({ saved: 0, pending: false });
    }
    running ||= syncOnce()
      .catch((e) => { console.warn('[OJ 기록기]', e); return { saved: 0, pending: false }; })
      .finally(() => { running = null; });
    return running;
  }

  // 제출 직후에는 채점이 끝날 때까지 짧은 간격으로 확인한다.
  function startBurst() {
    clearTimeout(burstTimer);
    const started = Date.now();
    const tick = async () => {
      const { pending } = await sync();
      const elapsed = Date.now() - started;
      if (elapsed < BURST_MAX_MS && (pending || elapsed < BURST_MIN_MS)) {
        burstTimer = setTimeout(tick, BURST_INTERVAL_MS);
      }
    };
    burstTimer = setTimeout(tick, 1500);
  }

  document.addEventListener('submit', (e) => {
    const action = e.target?.getAttribute?.('action') || '';
    if (action.includes('submit')) startBurst();
  }, true);

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (btn && /제출/.test(btn.textContent || '') && btn.closest('form')) startBurst();
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });

  const idleTimer = setInterval(() => {
    if (document.visibilityState === 'visible') sync();
  }, IDLE_INTERVAL_MS);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'syncNow') {
      sync().then(reply);
      return true;
    }
  });

  sync();
})();
