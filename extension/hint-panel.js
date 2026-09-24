// 채점 사이트의 문제 페이지에 힌트 패널을 띄운다. 힌트는 내 컴퓨터의 Claude 워커가 만든다.
// 페이지 스타일과 섞이지 않게 shadow DOM 안에 그린다.
(() => {
  const alive = () => !!chrome.runtime?.id;
  if (globalThis.__OJ_HINTS__?.alive()) return;
  globalThis.__OJ_HINTS__ = { alive };

  const MAX_LEVEL = 3;
  const DASHBOARD = 'https://oj-tracker.vercel.app';
  const adapters = globalThis.OJ_ADAPTERS || [];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  let adapter = null;
  let problemId = null;
  let host = null;
  let root = null;
  let open = false;
  let hints = [];
  let note = '';
  let timer = null;

  const pending = (h) => h.status === 'queued' || h.status === 'running';
  const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; }
    .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; padding: 10px 14px; border-radius: 999px;
      border: 1px solid #3f3f46; background: #18181b; color: #f4f4f5; font-size: 13px; cursor: pointer;
      box-shadow: 0 6px 20px rgb(0 0 0 / .35); }
    .panel { position: fixed; right: 18px; bottom: 64px; z-index: 2147483000; width: min(360px, calc(100vw - 36px));
      max-height: min(70vh, 560px); overflow: auto; background: #18181b; color: #f4f4f5; border: 1px solid #3f3f46;
      border-radius: 12px; padding: 14px; box-shadow: 0 10px 30px rgb(0 0 0 / .45); font-size: 13.5px; line-height: 1.6; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .head b { font-size: 14px; }
    .note { color: #a1a1aa; font-size: 11.5px; }
    .hint { border-left: 3px solid #3b82f6; padding: 2px 0 2px 10px; margin-bottom: 10px; }
    .hint.pending { border-left-color: #71717a; color: #a1a1aa; }
    .hint.failed { border-left-color: #f87171; }
    .level { color: #a1a1aa; font-size: 11.5px; }
    p { margin: 2px 0; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    .where { font-weight: 600; }
    .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    button.act { flex: 1; min-width: 120px; padding: 8px 10px; border-radius: 8px; border: 1px solid #3f3f46;
      background: transparent; color: #f4f4f5; font-size: 13px; cursor: pointer; }
    button.act.primary { background: #2563eb; border-color: #2563eb; }
    button.act:disabled { opacity: .5; cursor: default; }
    .empty { color: #a1a1aa; font-size: 12.5px; }
    .close { background: none; border: 0; color: #a1a1aa; cursor: pointer; font-size: 16px; }
    a.act { text-align: center; text-decoration: none; display: block; }
  `;

  function mount() {
    host = document.createElement('div');
    host.id = 'oj-hint-host';
    root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    render();
  }

  function unmount() {
    clearTimeout(timer);
    host?.remove();
    host = null; root = null; open = false; hints = [];
  }

  function hintCard(h) {
    const title = h.kind === 'code' ? '내 코드 진단' : `${h.level}단계 힌트`;
    if (pending(h)) return `<div class="hint pending"><div class="level">${title}</div><p>Claude가 생각하는 중… (30초~1분)</p></div>`;
    if (h.status === 'error') return `<div class="hint failed"><div class="level">${title}</div><p>${esc(h.error)}</p></div>`;
    const r = h.result;
    if (h.kind === 'code') {
      return `<div class="hint"><div class="level">${title}</div><p>${esc(r.summary)}</p>
        <ul>${(r.look_here || []).map((x) => `<li><span class="where">${esc(x.where)}</span> — ${esc(x.why)}</li>`).join('')}</ul>
        ${r.verdict_guess ? `<p class="note">${esc(r.verdict_guess)}</p>` : ''}</div>`;
    }
    return `<div class="hint"><div class="level">${title}</div><p>${esc(r.hint)}</p>
      ${(r.check_yourself || []).length ? `<ul>${r.check_yourself.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div>`;
  }

  function render() {
    if (!root) return;
    const levels = hints.filter((h) => h.kind === 'level' && h.status !== 'error').sort((a, b) => a.level - b.level);
    const nextLevel = (levels.at(-1)?.level ?? 0) + 1;
    const busy = hints.some(pending);
    const cards = [...hints.filter((h) => h.kind === 'level').sort((a, b) => a.level - b.level),
      ...hints.filter((h) => h.kind === 'code').slice(-2)].map(hintCard).join('');

    root.innerHTML = `<style>${STYLE}</style>
      <button class="fab" id="fab">힌트${busy ? ' …' : ''}</button>
      ${open ? `<div class="panel">
        <div class="head"><b>#${esc(problemId)} 힌트</b><button class="close" id="close">✕</button></div>
        <div class="note">${esc(note)}</div>
        <div>${cards || '<p class="empty">막히면 눌러보세요. 단계가 올라갈수록 구체적으로 알려줘요. 정답 코드는 알려주지 않아요.</p>'}</div>
        <div class="row">
          <a class="act link" id="library" href="${DASHBOARD}/library.html?judge=${encodeURIComponent(adapter.judge)}&problem=${encodeURIComponent(problemId)}" target="_blank" rel="noopener">코드 정리 열기</a>
        </div>
        <div class="row">
          <button class="act primary" id="next" ${busy || nextLevel > MAX_LEVEL ? 'disabled' : ''}>${nextLevel > MAX_LEVEL ? '힌트를 다 봤어요' : `${nextLevel}단계 힌트 보기`}</button>
          <button class="act" id="code" ${busy ? 'disabled' : ''}>내 코드 진단</button>
        </div>
      </div>` : ''}`;

    root.getElementById('fab').onclick = () => { open = !open; render(); if (open) refresh(); };
    if (!open) return;
    root.getElementById('close').onclick = () => { open = false; render(); };
    root.getElementById('next').onclick = () => request({ kind: 'level', level: nextLevel });
    root.getElementById('code').onclick = () => {
      const code = (adapter.currentCode?.() ?? '').trim();
      if (code.length < 20) { note = '편집기에 코드를 조금 더 쓴 뒤에 눌러주세요.'; render(); return; }
      request({ kind: 'code', code });
    };
  }

  async function request(row) {
    const res = await send('hintRequest', { row: { judge: adapter.judge, problem_id: problemId, ...row } });
    if (!res?.ok) { note = `힌트를 요청하지 못했어요: ${res?.error ?? '알 수 없는 오류'}`; render(); return; }
    hints.push(res.hint);
    render();
    schedule();
  }

  async function refresh() {
    const [list, status] = await Promise.all([
      send('hintList', { judge: adapter.judge, problemId }),
      send('workerStatus'),
    ]);
    if (!list?.ok) { note = list?.error?.includes('로그인') ? '확장 프로그램에서 로그인하면 쓸 수 있어요' : (list?.error ?? ''); render(); return; }
    hints = list.hints;
    const w = status?.worker;
    const online = w && Date.now() - Date.parse(w.last_seen) < 90_000;
    note = online ? 'Claude가 만들어요'
      : w ? 'Claude 워커가 꺼져 있어요. 켜면 밀린 요청부터 처리해요'
        : 'Claude를 연결하면 쓸 수 있어요 (대시보드 → Claude 연결)';
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (hints.some(pending) && open) timer = setTimeout(refresh, 5000);
  }

  // SPA라서 주소가 바뀌어도 새로 불러오지 않는다. 주소를 지켜보다가 문제 페이지에서만 띄운다.
  function check() {
    if (!alive()) { unmount(); clearInterval(watch); return; }
    adapter = adapters.find((a) => a.matches(location)) ?? null;
    const id = adapter?.currentProblemId?.(location) ?? null;
    if (id === problemId) return;
    problemId = id;
    if (!id) { unmount(); return; }
    if (!host) mount();
    hints = [];
    render();
    if (open) refresh();
  }
  const watch = setInterval(check, 1000);
  check();
})();
