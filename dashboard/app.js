import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

const VERDICTS = {
  Accepted: '맞았습니다',
  WrongAnswer: '틀렸습니다',
  TimeLimitExceeded: '시간 초과',
  MemoryLimitExceeded: '메모리 초과',
  RuntimeError: '런타임 에러',
  CompilationError: '컴파일 에러',
};
const VERDICT_COLORS = {
  Accepted: 'var(--ac)', WrongAnswer: 'var(--wa)', TimeLimitExceeded: 'var(--tle)',
  MemoryLimitExceeded: 'var(--tle)', RuntimeError: 'var(--re)', CompilationError: 'var(--ce)',
};
// supabase/functions/_shared/analysis.js의 MISTAKE_TAGS와 같게 유지한다.
const MISTAKE_TAGS = {
  overflow: '자료형 범위(오버플로)', boundary: '경계값/인덱스', init: '초기화 누락', complexity: '시간복잡도',
  io_format: '입출력 형식', misread: '문제 조건 오해', algorithm: '알고리즘 선택', implementation: '구현 실수',
  compile: '컴파일/문법', runtime: '런타임(배열 범위, 0 나누기, 재귀 깊이)', precision: '실수 정밀도', other: '기타',
};
const ROUTE_REASONS = {
  simple: '맞은 코드와 비교하면 되는 문제', unsolved: '아직 못 푼 문제',
  multiple_verdicts: '틀린 종류가 여러 가지', big_change: '맞힐 때 코드를 많이 바꿈',
};
const LANG_HL = { cpp: 'cpp', c: 'c', python: 'python', py: 'python', java: 'java' };
const JUDGE_PROBLEM_URL = {
  dshs: (id) => `https://dshs.app/oj/problem/${id}`,
  self: (id) => `/oj/problem.html?id=${id}`,
};
const JUDGE_LABEL = { self: '연습장' };
const WORKER_ONLINE_MS = 90_000;
const RUNNING_TIMEOUT_MS = 5 * 60_000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const verdictName = (v) => VERDICTS[v] ?? v ?? '-';
const verdictClass = (v) => (VERDICTS[v] ? `v v-${v}` : 'v v-other');
const tagName = (t) => MISTAKE_TAGS[t] ?? t;
const fmtTime = (t) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
const ago = (t) => {
  const s = Math.round((Date.now() - Date.parse(t)) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
};

let submissions = [];
let analyses = [];
let worker = null;
let pollTimer = null;
let openKey = null;

// ---------- 인증 ----------
function loginMsg(text, kind) {
  $('login-msg').textContent = text;
  $('login-msg').className = `msg ${kind}`;
  $('login-msg').hidden = !text;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  if (error) loginMsg(error.message, 'err');
});
$('sign-up').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || password.length < 6) return loginMsg('이메일과 6자 이상 비밀번호를 입력하세요.', 'err');
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) return loginMsg(error.message, 'err');
  if (!data.session) loginMsg('가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요.', 'ok');
});
// 이 브라우저만 로그아웃한다. (기본값 global은 확장 프로그램과 Claude 워커까지 끊는다)
$('sign-out').addEventListener('click', () => sb.auth.signOut({ scope: 'local' }));

let loadedFor = null;
sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user;
  $('login').hidden = !!user;
  $('app').hidden = !user;
  $('account').hidden = !user;
  $('who').textContent = user?.email ?? '';
  // 연습장에서 로그인하러 왔으면 로그인 후 돌려보낸다. (같은 사이트 경로만)
  const next = new URLSearchParams(location.search).get('next');
  if (user && next && next.startsWith('/') && !next.startsWith('//')) { location.replace(next); return; }
  if (user && loadedFor !== user.id) { loadedFor = user.id; load(); }
  if (!user) { loadedFor = null; submissions = []; analyses = []; clearTimeout(pollTimer); }
});

// ---------- 데이터 ----------
const LIST_COLUMNS = 'judge,submission_id,problem_id,problem_title,contest_id,language,status,verdict,max_time_ms,max_memory_kb,failed_testcase,submitted_at';

async function selectAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function load() {
  try {
    [submissions, analyses] = await Promise.all([
      selectAll(() => sb.from('submissions').select(LIST_COLUMNS).order('submitted_at', { ascending: true })),
      loadAnalyses(),
    ]);
    worker = (await sb.from('claude_workers').select('*').maybeSingle()).data;
  } catch (e) {
    alert(`불러오기 실패: ${e.message}`);
    return;
  }
  render();
}

const loadAnalyses = () => selectAll(() => sb.from('analyses').select('*').order('created_at', { ascending: true }));

// 분석이 진행 중이면 몇 초마다 새로 읽는다.
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = analyses.some((a) => (a.status === 'running' && Date.now() - Date.parse(a.updated_at) < RUNNING_TIMEOUT_MS)
    || (a.status === 'queued' && workerOnline()));
  if (!busy) return;
  pollTimer = setTimeout(async () => {
    try {
      analyses = await loadAnalyses();
      worker = (await sb.from('claude_workers').select('*').maybeSingle()).data;
    } catch { /* 다음 주기에 다시 시도 */ }
    render();
  }, 5000);
}

const workerOnline = () => worker && Date.now() - Date.parse(worker.last_seen) < WORKER_ONLINE_MS;

// 문제별로 묶고, 가장 최근 분석을 붙인다.
function groupByProblem() {
  const map = new Map();
  for (const s of submissions) {
    const key = `${s.judge}:${s.problem_id}`;
    if (!map.has(key)) map.set(key, { key, judge: s.judge, id: s.problem_id, title: s.problem_title, list: [] });
    const p = map.get(key);
    p.list.push(s);
    if (s.problem_title) p.title = s.problem_title;
  }
  const latest = new Map();
  for (const a of analyses) if (a.kind === 'problem') latest.set(`${a.judge}:${a.problem_id}`, a);
  for (const p of map.values()) {
    p.solved = p.list.some((s) => s.verdict === 'Accepted');
    p.wrong = p.list.filter((s) => s.verdict !== 'Accepted').length;
    p.last = p.list[p.list.length - 1];
    p.analysis = latest.get(p.key) ?? null;
    p.state = analysisState(p);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.last.submitted_at) - Date.parse(a.last.submitted_at));
}

// 서버의 route()와 같은 기준을 제출 결과만으로 미리 본다. (코드 변경량 기준은 서버가 판단)
function predictEngine(p) {
  const firstAc = p.list.findIndex((s) => s.verdict === 'Accepted');
  const wrong = p.list.filter((s) => s.verdict !== 'Accepted');
  if (!wrong.length || (firstAc >= 0 && !p.list.slice(0, firstAc).some((s) => s.verdict !== 'Accepted'))) return null;
  if (firstAc < 0 || new Set(wrong.map((s) => s.verdict)).size > 1) return 'claude';
  return 'gemma';
}

// 표에 보여줄 분석 상태
function analysisState(p) {
  const a = p.analysis;
  const current = p.list.map((s) => s.submission_id);
  const stale = a && (current.length !== a.submission_ids.length || current.some((id) => !a.submission_ids.includes(id)));
  if (!a) {
    const engine = predictEngine(p);
    if (!engine) return { id: 'first_try', label: '분석할 오답 없음', cls: 'muted' };
    if (engine === 'claude' && !worker) return { id: 'needs_claude', label: 'Claude 분석 필요', cls: 'claude' };
    return { id: 'new', label: '분석 전', cls: 'muted', canRun: true, engine };
  }
  if (a.status === 'skipped') {
    const label = a.route_reason === 'empty_attempt' ? '빈 코드만 틀림' : '분석할 오답 없음';
    return { id: 'first_try', label, cls: 'muted', stale, canRun: stale, reason: a.route_reason };
  }
  if (a.status === 'running' && Date.now() - Date.parse(a.updated_at) > RUNNING_TIMEOUT_MS) {
    return { id: 'error', label: '시간 초과', cls: 'err', canRun: true };
  }
  if (a.status === 'running') return { id: 'running', label: '분석 중…', cls: 'busy' };
  if (a.status === 'queued') return { id: 'queued', label: workerOnline() ? 'Claude 분석 중…' : 'Claude 워커 대기', cls: workerOnline() ? 'busy' : 'claude' };
  if (a.status === 'needs_claude') return { id: 'needs_claude', label: 'Claude 분석 필요', cls: 'claude', canRun: stale || !!worker };
  if (a.status === 'error') return { id: 'error', label: '분석 실패', cls: 'err', canRun: true };
  return {
    id: 'done', label: a.engine === 'claude' ? 'Claude 분석' : 'Gemma 분석', cls: a.engine,
    stale, canRun: stale,
  };
}

async function requestAnalysis(body) {
  const { data, error } = await sb.functions.invoke('analyze', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch {}
    throw new Error(msg);
  }
  return data;
}

async function analyzeProblem(p) {
  const row = await requestAnalysis({ kind: 'problem', judge: p.judge, problem_id: p.id });
  if (row.id) analyses.push(row);
  render();
  return row;
}

// ---------- 화면 ----------
function render() {
  const problems = groupByProblem();
  renderStats(problems);
  renderClaude(problems);
  renderOverall(problems);
  renderMistakes(problems);
  renderProblems(problems);
  if (openKey && $('detail').open) {
    const p = problems.find((x) => x.key === openKey);
    if (p && detailSig(p) !== shownSig) refreshDetail(p);
  }
  schedulePoll();
}

function renderStats(problems) {
  const total = submissions.length;
  const solved = problems.filter((p) => p.solved).length;
  const firstTry = problems.filter((p) => p.list[0].verdict === 'Accepted').length;
  const counts = {};
  for (const s of submissions) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  const bar = entries.map(([v, n]) =>
    `<span style="width:${(n / total) * 100}%;background:${VERDICT_COLORS[v] ?? 'var(--other)'}" title="${esc(verdictName(v))} ${n}"></span>`).join('');
  const legend = entries.map(([v, n]) =>
    `<span><i class="dot" style="background:${VERDICT_COLORS[v] ?? 'var(--other)'}"></i>${esc(verdictName(v))} ${n}</span>`).join('');

  $('stats').innerHTML = `
    <div class="stat"><div class="label">총 제출</div><div class="value">${total}</div></div>
    <div class="stat"><div class="label">맞힌 문제 / 시도한 문제</div><div class="value">${solved} / ${problems.length}</div></div>
    <div class="stat"><div class="label">한 번에 맞힌 문제</div><div class="value">${firstTry}</div></div>
    <div class="stat"><div class="label">결과 분포</div>
      ${total ? `<div class="bar">${bar}</div><div class="legend">${legend}</div>` : '<div class="value">-</div>'}
    </div>`;
}

function renderClaude(problems) {
  const waiting = problems.filter((p) => ['needs_claude', 'queued'].includes(p.state.id)).length;
  let html;
  if (!worker) {
    html = `<span class="pill claude">Claude 미연결</span>
      <span>기본 분석은 Gemma(무료)가 해요. 못 푼 문제나 원인이 여러 개인 문제는 Claude가 필요해요${waiting ? ` (지금 ${waiting}문제)` : ''}.</span>
      <details class="howto" ${linkCode ? 'open' : ''}><summary>Claude 연결 방법</summary>
        <ol>
          <li>Claude Code를 설치하고 로그인해요. (Claude 구독 필요)</li>
          <li>연결 코드를 받아서, 저장소의 <code>analyzer</code> 폴더에서 아래 명령을 실행해요.
            <div class="link-box">${linkCode
              ? `<code class="cmd">node worker.js link ${esc(linkCode.code)}</code><span class="muted small">${esc(linkExpiry())}</span>`
              : '<button id="make-link">연결 코드 받기</button>'}</div></li>
          <li><code>node worker.js</code>로 워커를 켜두면, 어려운 문제는 내 컴퓨터의 Claude가 분석해요.</li>
        </ol>
      </details>`;
  } else if (workerOnline()) {
    html = `<span class="pill ok">Claude 연결됨</span><span class="muted">워커 ${esc(worker.model ?? '')} · ${ago(worker.last_seen)} 확인${waiting ? ` · 대기 ${waiting}개` : ''}</span>`;
  } else {
    html = `<span class="pill claude">Claude 워커 꺼짐</span><span class="muted">마지막 확인 ${ago(worker.last_seen)}${waiting ? ` · 워커를 켜면 ${waiting}문제를 분석해요` : ''} (<code>node worker.js</code>)</span>
      <details class="howto" ${linkCode ? 'open' : ''}><summary>워커 연결이 끊겼다면 다시 연결하기</summary>
        <div class="link-box">${linkCode
          ? `<code class="cmd">node worker.js link ${esc(linkCode.code)}</code><span class="muted small">${esc(linkExpiry())}</span>`
          : '<button id="make-link">연결 코드 받기</button>'}</div>
      </details>`;
  }
  $('claude-status').innerHTML = html;
  $('make-link')?.addEventListener('click', makeLinkCode);
}

// 워커 연결용 일회용 코드 (10분 유효). 비밀번호 대신 이 코드로 워커를 연결한다.
let linkCode = null;
const linkExpiry = () => {
  const s = Math.max(0, Math.round((Date.parse(linkCode.expires_at) - Date.now()) / 1000));
  return s ? `${Math.floor(s / 60)}분 ${s % 60}초 동안 한 번만 쓸 수 있어요` : '만료됐어요. 새로고침 후 다시 받으세요';
};
async function makeLinkCode() {
  const { data, error } = await sb.functions.invoke('worker-link', { body: { action: 'create' } });
  if (error) { alert(`코드를 받지 못했어요: ${error.message}`); return; }
  linkCode = data;
  render();
  // 워커가 연결되면 바로 알 수 있게 잠시 확인한다.
  const until = Date.parse(linkCode.expires_at);
  const check = async () => {
    worker = (await sb.from('claude_workers').select('*').maybeSingle()).data;
    if (workerOnline()) { linkCode = null; render(); return; }
    if (Date.now() < until) { renderClaude(groupByProblem()); setTimeout(check, 5000); }
    else { linkCode = null; render(); }
  };
  setTimeout(check, 5000);
}

// 종합 리포트의 문제 키("dshs:62", "self:2", 예전 형식은 "62")를 문제로 바꾼다.
const problemLabel = (k) => {
  const [judge, id] = k.includes(':') ? k.split(':') : [null, k];
  return `${JUDGE_LABEL[judge] ? `${JUDGE_LABEL[judge]} ` : ''}#${id}`;
};
const findByReportKey = (k) => {
  const all = groupByProblem();
  return k.includes(':') ? all.find((p) => p.key === k) : all.find((p) => p.id === k && p.judge === 'dshs') ?? all.find((p) => p.id === k);
};

function renderOverall(problems) {
  const overall = analyses.filter((a) => a.kind === 'overall').at(-1);
  const analyzed = problems.filter((p) => p.state.id === 'done').length;
  const busy = overall && (overall.status === 'running' || overall.status === 'queued');
  const btn = $('overall-run');
  btn.disabled = !analyzed || busy || !!bulk;
  const targets = bulkTargets(problems);
  $('analyze-everything').disabled = !!bulk || busy || (!targets.length && !analyzed);
  $('analyze-everything').title = targets.length ? `문제 ${targets.length}개를 분석한 뒤 종합 리포트를 만들어요` : '분석할 새 문제가 없으면 종합 리포트만 다시 만들어요';
  $('bulk-status').hidden = !bulk;
  if (bulk) $('bulk-status').innerHTML = `<span class="pill busy">전체 분석 중</span> ${esc(bulk.text)}${bulk.notes.length ? `<div class="muted small">${bulk.notes.map(esc).join('<br>')}</div>` : ''}`;
  btn.textContent = overall ? '다시 만들기' : '종합 리포트 만들기';
  const body = $('overall-body');

  if (!overall) {
    body.innerHTML = `<p class="muted">${analyzed ? `분석된 ${analyzed}문제를 바탕으로 반복되는 약점을 정리해요.` : '문제별 분석이 하나 이상 끝나면 만들 수 있어요.'}</p>`;
    return;
  }
  const engine = `<span class="pill ${esc(overall.engine)}">${overall.engine === 'claude' ? 'Claude' : 'Gemma'}</span>`;
  if (busy) { body.innerHTML = `<p class="muted">${engine} 종합 리포트를 만드는 중…</p>`; return; }
  if (overall.status === 'error') { body.innerHTML = `<p class="msg err">만들지 못했어요: ${esc(overall.error)}</p>`; return; }
  const o = overall.result;
  body.innerHTML = `
    <p class="overview">${esc(o.overview)}</p>
    <div class="weak-list">${o.top_weaknesses.map((w) => `
      <div class="weak">
        <div class="weak-head"><b>${esc(w.title)}</b><span class="tag">${esc(tagName(w.tag))}</span></div>
        <p>${esc(w.description)}</p>
        <p class="muted small">근거 ${w.problems.map((k) => `<a href="#" data-problem="${esc(k)}">${esc(problemLabel(k))}</a>`).join(' ')}</p>
        <p class="practice"><span class="label">연습</span>${esc(w.practice)}</p>
      </div>`).join('')}
    </div>
    <div class="two">
      <div><h3>잘하는 점</h3><ul>${o.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
      <div><h3>다음에 할 일</h3><ul>${o.next_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
    </div>
    <p class="muted small">${engine} ${fmtTime(overall.updated_at)} 기준</p>`;
}

$('overall-run').addEventListener('click', async () => {
  $('overall-run').disabled = true;
  try {
    const row = await requestAnalysis({ kind: 'overall' });
    analyses.push(row);
  } catch (e) {
    alert(e.message);
  }
  render();
});
$('overall-body').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-problem]');
  if (!a) return;
  e.preventDefault();
  const p = findByReportKey(a.dataset.problem);
  if (p) openProblem(p);
});

// 분석된 문제들에서 틀린 제출별 실수 유형을 센다.
function renderMistakes(problems) {
  const counts = {};
  const where = {};
  for (const p of problems) {
    if (p.state.id !== 'done') continue;
    for (const a of p.analysis.result.attempts) {
      counts[a.tag] = (counts[a.tag] || 0) + 1;
      (where[a.tag] ||= new Set()).add(p.id);
    }
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] || 1;
  $('mistakes').innerHTML = entries.length
    ? entries.map(([t, n]) => `
      <div class="mrow" title="${esc([...where[t]].map((id) => `#${id}`).join(', '))}">
        <span class="mname">${esc(tagName(t))}</span>
        <span class="mbar"><span style="width:${(n / max) * 100}%"></span></span>
        <span class="mnum">${n}</span>
      </div>`).join('')
    : '<p class="muted">분석이 끝난 문제가 생기면 틀린 제출마다 실수 유형을 모아 보여줘요.</p>';
}

function renderProblems(problems) {
  const q = $('filter').value.trim().toLowerCase();
  const shown = problems.filter((p) => !q || p.id.includes(q) || (p.title || '').toLowerCase().includes(q));
  $('empty').hidden = submissions.length > 0;
  $('problems').innerHTML = shown.map((p) => `
    <tr data-key="${esc(p.key)}">
      <td>${JUDGE_LABEL[p.judge] ? `<span class="tag">${JUDGE_LABEL[p.judge]}</span>` : ''}<span class="pid">#${esc(p.id)}</span>${esc(p.title)}</td>
      <td>${p.solved ? '<span class="badge v-Accepted">해결</span>' : '<span class="badge v-WrongAnswer">미해결</span>'}</td>
      <td class="num">${p.list.length}</td>
      <td class="num">${p.wrong}</td>
      <td class="${verdictClass(p.last.verdict)}">${esc(verdictName(p.last.verdict))}</td>
      <td><span class="pill ${p.state.cls}">${esc(p.state.label)}</span>${p.state.stale ? ' <span class="pill muted">새 제출</span>' : ''}</td>
      <td class="muted">${fmtTime(p.last.submitted_at)}</td>
    </tr>`).join('');
  $('problems').onclick = (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openProblem(problems.find((p) => p.key === tr.dataset.key));
  };

  const todo = problems.filter((p) => p.state.canRun && p.state.id !== 'needs_claude' && p.state.id !== 'error'
    && !(p.state.engine === 'claude' && !worker));
  $('analyze-all').hidden = !todo.length;
  $('analyze-all').textContent = `새 문제 ${todo.length}개 분석`;
  $('analyze-all').onclick = () => analyzeMany(todo);
}
$('filter').addEventListener('input', () => renderProblems(groupByProblem()));

async function analyzeMany(list) {
  $('analyze-all').disabled = true;
  for (const p of list) {
    try { await analyzeProblem(p); } catch (e) { alert(`#${p.id}: ${e.message}`); break; }
    await new Promise((r) => setTimeout(r, 1500)); // 무료 모델 호출 제한을 피하려고 간격을 둔다
  }
  $('analyze-all').disabled = false;
}

// ---------- 전체 한 번에 분석 ----------
// 분석이 필요한 문제를 모두 분석하고, 끝나길 기다렸다가 종합 리포트까지 만든다.
let bulk = null; // { text, notes[] }

// 지금 분석을 요청할 수 있는 문제: 분석 전, 새 제출이 생긴 것, 실패한 것. Claude가 필요한데 연결이 없으면 뺀다.
function bulkTargets(problems) {
  return problems.filter((p) => p.state.canRun && !(p.state.engine === 'claude' && !worker)
    && !(p.state.id === 'needs_claude' && !worker));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function bulkStep(text) { bulk.text = text; render(); }

async function analyzeEverything() {
  bulk = { text: '', notes: [] };
  const targets = bulkTargets(groupByProblem());
  const requested = [];
  for (const [i, p] of targets.entries()) {
    bulkStep(`문제별 분석 요청 ${i + 1} / ${targets.length} (${problemLabel(p.key)})`);
    try {
      const row = await analyzeProblem(p);
      if (row?.id) requested.push(row.id);
    } catch (e) {
      bulk.notes.push(`${problemLabel(p.key)}: ${e.message}`);
      if (/한도/.test(e.message)) break; // 오늘 Gemma 한도를 다 썼으면 나머지도 안 된다
    }
    await sleep(1500); // 무료 모델 호출 제한을 피하려고 간격을 둔다
  }

  // 요청한 분석이 끝날 때까지 기다린다. Claude 워커가 꺼져 있으면 그 문제는 기다리지 않는다.
  const deadline = Date.now() + 10 * 60_000;
  while (requested.length && Date.now() < deadline) {
    try {
      analyses = await loadAnalyses();
      worker = (await sb.from('claude_workers').select('*').maybeSingle()).data;
    } catch { /* 다음 주기에 다시 */ }
    const waiting = analyses.filter((a) => requested.includes(a.id)
      && ((a.status === 'running' && Date.now() - Date.parse(a.updated_at) < RUNNING_TIMEOUT_MS)
        || (a.status === 'queued' && workerOnline())));
    if (!waiting.length) break;
    bulkStep(`문제별 분석 끝나길 기다리는 중… (${waiting.length}개 남음, Gemma는 문제당 30초~2분)`);
    await sleep(5000);
  }
  const failed = analyses.filter((a) => requested.includes(a.id) && a.status === 'error').length;
  if (failed) bulk.notes.push(`${failed}개 문제는 분석에 실패했어요. 표에서 "분석 실패"를 눌러 다시 시도할 수 있어요.`);

  bulkStep('종합 리포트 만드는 중…');
  try {
    analyses.push(await requestAnalysis({ kind: 'overall' }));
  } catch (e) {
    bulk.notes.push(`종합 리포트: ${e.message}`);
    bulkStep('끝났어요');
    await sleep(6000);
  }
  bulk = null;
  render();
}
$('analyze-everything').addEventListener('click', () => { if (!bulk) analyzeEverything(); });

// ---------- 삭제 ----------
// 브라우저 확인창 대신, 한 번 더 누르게 하는 버튼으로 실수를 막는다.
function armDelete(btn, label, action) {
  btn.addEventListener('click', async () => {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = label;
      btn.classList.add('danger-armed');
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('danger-armed'); } }, 4000);
      return;
    }
    btn.disabled = true;
    try { await action(); } catch (e) { alert(`삭제하지 못했어요: ${e.message}`); btn.disabled = false; }
  });
}

const check = ({ error }) => { if (error) throw error; };

async function deleteSubmission(s) {
  check(await sb.from('submissions').delete().eq('judge', s.judge).eq('submission_id', s.submission_id));
  submissions = submissions.filter((x) => !(x.judge === s.judge && x.submission_id === s.submission_id));
  codeCache.delete(`${s.judge}:${s.submission_id}`);
}

async function deleteProblem(p) {
  check(await sb.from('submissions').delete().eq('judge', p.judge).eq('problem_id', p.id));
  check(await sb.from('analyses').delete().eq('judge', p.judge).eq('problem_id', p.id));
  check(await sb.from('problems').delete().eq('judge', p.judge).eq('problem_id', p.id));
  submissions = submissions.filter((x) => x.judge !== p.judge || x.problem_id !== p.id);
  analyses = analyses.filter((a) => a.judge !== p.judge || a.problem_id !== p.id);
}

async function deleteEverything() {
  // RLS 때문에 본인 행만 지워진다. 조건이 없는 delete는 막혀 있어서 항상 참인 조건을 준다.
  check(await sb.from('analyses').delete().not('id', 'is', null));
  check(await sb.from('submissions').delete().not('submission_id', 'is', null));
  check(await sb.from('problems').delete().not('problem_id', 'is', null));
  submissions = [];
  analyses = [];
}

armDelete($('delete-all'), '정말 모두 삭제', async () => {
  await deleteEverything();
  $('delete-all').disabled = false;
  $('delete-all').textContent = $('delete-all').dataset.label;
  render();
});

// ---------- 문제 상세 ----------
const codeCache = new Map();

function openProblem(p) {
  openKey = p.key;
  const url = JUDGE_PROBLEM_URL[p.judge]?.(p.id);
  $('detail-title').innerHTML = `<span class="pid">#${esc(p.id)}</span>${
    url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}`;
  $('detail-actions').innerHTML = '<button class="danger" id="delete-problem" data-label="문제 기록 삭제">문제 기록 삭제</button>';
  armDelete($('delete-problem'), `제출 ${p.list.length}개 모두 삭제`, async () => {
    await deleteProblem(p);
    $('detail').close();
    render();
  });
  if (!$('detail').open) $('detail').showModal();
  refreshDetail(p, true);
}

// 분석 결과가 바뀌면 열린 창도 다시 그린다. 보고 있던 항목은 유지한다.
let shownSig = null;
const detailSig = (p) => `${p.list.length}|${p.state.id}|${p.analysis?.id}|${p.analysis?.updated_at}`;
function refreshDetail(p, reset = false) {
  shownSig = detailSig(p);
  const list = [...p.list].reverse();
  const n = (s) => p.list.indexOf(s) + 1; // 분석 결과의 제출 번호 (오래된 순, 1부터)
  const causes = new Map((p.state.id === 'done' ? p.analysis.result.attempts : []).map((a) => [a.n, a]));
  const active = reset ? 'analysis' : ($('attempts').querySelector('li.active')?.dataset.i ?? 'analysis');

  $('attempts').innerHTML = `
    <li data-i="analysis"><div><b>분석</b></div><div class="sub"><span class="pill ${p.state.cls}">${esc(p.state.label)}</span></div></li>
    ${list.map((s, i) => {
      const c = causes.get(n(s));
      return `<li data-i="${i}">
        <div class="${verdictClass(s.verdict)}">제출 ${n(s)} · ${esc(verdictName(s.verdict))}${
          s.failed_testcase ? ` <span class="sub">#${s.failed_testcase}</span>` : ''}</div>
        <div class="sub">${fmtTime(s.submitted_at)} · ${s.max_time_ms ?? '-'}ms</div>
        ${c ? `<div><span class="tag">${esc(tagName(c.tag))}</span></div>` : ''}
      </li>`;
    }).join('')}`;
  $('attempts').onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    if (li.dataset.i === 'analysis') showAnalysis(p, li);
    else showAttempt(list[+li.dataset.i], li, causes.get(n(list[+li.dataset.i])), n(list[+li.dataset.i]));
  };
  const li = $('attempts').querySelector(`li[data-i="${active}"]`) ?? $('attempts').firstElementChild;
  li.click();
}

function showAnalysis(p, li) {
  [...$('attempts').children].forEach((el) => el.classList.toggle('active', el === li));
  const view = $('attempt-view');
  const a = p.analysis;
  const st = p.state;
  const runBtn = (label) => `<button class="primary" id="run-analysis">${label}</button>`;
  let html;

  if (st.id === 'first_try') {
    html = st.reason === 'empty_attempt'
      ? '<p class="muted">맞히기 전에 틀린 제출이 모두 빈 코드(뼈대만 있는 코드)라서 분석할 게 없어요.</p>'
      : '<p class="muted">맞히기 전에 틀린 제출이 없어서 분석할 게 없어요.</p>';
    if (st.stale) html += `<div class="callout">이 판단 뒤에 새 제출이 있어요. ${runBtn('다시 분석')}</div>`;
  } else if (st.id === 'new') {
    html = `<p>이 문제는 ${st.engine === 'claude' ? '<b>Claude</b>' : '<b>Gemma</b>(무료)'}가 분석해요.</p>${runBtn('분석하기')}`;
  } else if (st.id === 'needs_claude') {
    const reason = ROUTE_REASONS[a?.route_reason] ?? (p.solved ? '틀린 종류가 여러 가지' : '아직 못 푼 문제');
    html = `<div class="callout claude"><b>Claude 분석 필요</b>
      <p>${esc(reason)}라서 Gemma로는 원인을 믿을 만하게 찾기 어려워요. Gemma는 이런 문제에서 그럴듯하지만 틀린 원인을 확신 있게 내놓는 경향이 있었어요.</p>
      <p class="muted">Claude를 연결하면 자동으로 분석돼요. 방법은 대시보드 위쪽의 "Claude 연결 방법"을 보세요.</p></div>
      ${st.canRun ? runBtn(worker ? 'Claude로 분석하기' : '다시 확인') : ''}`;
  } else if (st.id === 'running' || st.id === 'queued') {
    html = `<p class="muted">${esc(st.label)} ${a.engine === 'gemma' ? 'Gemma는 30초~2분쯤 걸려요.' : ''}</p>`;
  } else if (st.id === 'error') {
    html = `<p class="msg err">분석하지 못했어요${a?.error ? `: ${esc(a.error)}` : ''}</p>${runBtn('다시 분석')}`;
  } else {
    const o = a.result;
    const conf = { high: '높음', medium: '중간', low: '낮음' }[o.confidence];
    html = `
      <div class="meta"><span class="pill ${esc(a.engine)}">${a.engine === 'claude' ? 'Claude' : 'Gemma'}</span>
        <span>확신 <b>${conf}</b></span><span>${fmtTime(a.updated_at)}</span></div>
      ${st.stale ? `<div class="callout">이 분석 뒤에 새 제출이 있어요. ${runBtn('다시 분석')}</div>` : ''}
      <p class="overview">${esc(o.summary)}</p>
      <h3>틀린 제출별 원인</h3>
      <ul class="causes">${o.attempts.map((c) => `<li><span class="mono muted">제출 ${c.n}</span> <span class="tag">${esc(tagName(c.tag))}</span><br>${esc(c.cause)}</li>`).join('')}</ul>
      <h3>맞게 된 수정</h3><p>${o.fix_point ? esc(o.fix_point) : '<span class="muted">아직 못 풂</span>'}</p>
      <h3>드러난 약점</h3>
      <ul class="causes">${o.weak_points.map((w) => `<li><span class="tag">${esc(tagName(w.tag))}</span>${esc(w.description)}</li>`).join('')}</ul>
      <h3>다음에 확인할 것</h3><p>${esc(o.advice)}</p>`;
  }
  view.innerHTML = html;
  $('run-analysis')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await analyzeProblem(p); } catch (err) { alert(err.message); e.target.disabled = false; }
  });
}

async function showAttempt(s, li, cause, n) {
  [...$('attempts').children].forEach((el) => el.classList.toggle('active', el === li));
  const view = $('attempt-view');
  const key = `${s.judge}:${s.submission_id}`;
  let full = codeCache.get(key);
  if (!full) {
    view.innerHTML = '<p class="muted">불러오는 중…</p>';
    const { data, error } = await sb.from('submissions')
      .select('source_code,compile_output,testcase_results')
      .eq('judge', s.judge).eq('submission_id', s.submission_id).single();
    if (error) { view.innerHTML = `<p class="msg err">${esc(error.message)}</p>`; return; }
    full = data;
    codeCache.set(key, full);
  }
  if (!li.classList.contains('active')) return; // 그 사이 다른 항목을 눌렀다

  const tcs = full.testcase_results || [];
  const lang = LANG_HL[s.language] ?? 'plaintext';
  let code = esc(full.source_code);
  if (window.hljs && full.source_code) {
    try { code = window.hljs.highlight(full.source_code, { language: lang }).value; } catch {}
  }

  view.innerHTML = `
    <div class="meta">
      <span class="${verdictClass(s.verdict)}">제출 ${n} · ${esc(verdictName(s.verdict))}</span>
      <span>언어 <b>${esc(s.language ?? '-')}</b></span>
      <span>시간 <b>${s.max_time_ms ?? '-'}ms</b></span>
      <span>메모리 <b>${s.max_memory_kb != null ? Math.round(s.max_memory_kb / 1024) + 'MB' : '-'}</b></span>
      ${s.failed_testcase ? `<span>틀린 테스트케이스 <b>#${s.failed_testcase}</b></span>` : ''}
      ${s.contest_id ? `<span>대회 <b>${esc(s.contest_id)}</b></span>` : ''}
      <span>${fmtTime(s.submitted_at)}</span>
    </div>
    ${cause ? `<div class="callout"><span class="tag">${esc(tagName(cause.tag))}</span>${esc(cause.cause)}</div>` : ''}
    ${tcs.length ? `<h3>테스트케이스</h3><div class="tc">${tcs.map((t) =>
      `<span class="${verdictClass(t.verdict)}" title="${esc(verdictName(t.verdict))} · ${t.time_ms}ms">#${t.index + 1}</span>`).join('')}</div>` : ''}
    ${full.compile_output ? `<h3>채점 메시지</h3><pre class="plain">${esc(full.compile_output)}</pre>` : ''}
    <h3>코드</h3>
    <pre><code class="hljs language-${lang}">${code}</code></pre>
    <button class="danger" id="delete-sub" data-label="이 제출 삭제">이 제출 삭제</button>`;
  armDelete($('delete-sub'), '정말 삭제', async () => {
    await deleteSubmission(s);
    const p = groupByProblem().find((x) => x.key === openKey);
    if (!p) $('detail').close(); // 마지막 제출이었으면 문제도 목록에서 사라진다
    render();
  });
}

$('detail-close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
$('detail').addEventListener('close', () => { openKey = null; });
