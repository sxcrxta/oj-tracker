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
const LANG_HL = { cpp: 'cpp', c: 'c', python: 'python', py: 'python', java: 'java' };
const JUDGE_PROBLEM_URL = { dshs: (id) => `https://dshs.app/oj/problem/${id}` };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const verdictName = (v) => VERDICTS[v] ?? v ?? '-';
const verdictClass = (v) => (VERDICTS[v] ? `v v-${v}` : 'v v-other');
const fmtTime = (t) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

let submissions = [];

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
$('sign-out').addEventListener('click', () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user;
  $('login').hidden = !!user;
  $('app').hidden = !user;
  $('account').hidden = !user;
  $('who').textContent = user?.email ?? '';
  if (user) load();
  else submissions = [];
});

// ---------- 데이터 ----------
const LIST_COLUMNS = 'judge,submission_id,problem_id,problem_title,contest_id,language,status,verdict,max_time_ms,max_memory_kb,failed_testcase,submitted_at';

async function load() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('submissions').select(LIST_COLUMNS)
      .order('submitted_at', { ascending: true }).range(from, from + 999);
    if (error) { alert(`불러오기 실패: ${error.message}`); return; }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  submissions = rows;
  render();
}

// 문제별로 묶는다. (분석 기능을 붙일 때도 이 구조를 쓴다)
function groupByProblem(rows) {
  const map = new Map();
  for (const s of rows) {
    const key = `${s.judge}:${s.problem_id}`;
    if (!map.has(key)) map.set(key, { key, judge: s.judge, id: s.problem_id, title: s.problem_title, list: [] });
    const p = map.get(key);
    p.list.push(s);
    if (s.problem_title) p.title = s.problem_title;
  }
  for (const p of map.values()) {
    p.solved = p.list.some((s) => s.verdict === 'Accepted');
    p.wrong = p.list.filter((s) => s.verdict !== 'Accepted').length;
    p.last = p.list[p.list.length - 1];
  }
  return [...map.values()].sort((a, b) => Date.parse(b.last.submitted_at) - Date.parse(a.last.submitted_at));
}

// ---------- 화면 ----------
function render() {
  const problems = groupByProblem(submissions);
  renderStats(problems);
  renderProblems(problems);
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

function renderProblems(problems) {
  const q = $('filter').value.trim().toLowerCase();
  const shown = problems.filter((p) => !q || p.id.includes(q) || (p.title || '').toLowerCase().includes(q));
  $('empty').hidden = submissions.length > 0;
  $('problems').innerHTML = shown.map((p) => `
    <tr data-key="${esc(p.key)}">
      <td><span class="pid">#${esc(p.id)}</span>${esc(p.title)}</td>
      <td>${p.solved ? '<span class="badge v-Accepted">해결</span>' : '<span class="badge v-WrongAnswer">미해결</span>'}</td>
      <td class="num">${p.list.length}</td>
      <td class="num">${p.wrong}</td>
      <td class="${verdictClass(p.last.verdict)}">${esc(verdictName(p.last.verdict))}</td>
      <td class="muted">${fmtTime(p.last.submitted_at)}</td>
    </tr>`).join('');
  $('problems').onclick = (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openProblem(problems.find((p) => p.key === tr.dataset.key));
  };
}
$('filter').addEventListener('input', () => renderProblems(groupByProblem(submissions)));

// ---------- 문제 상세 ----------
const codeCache = new Map();

function openProblem(p) {
  const url = JUDGE_PROBLEM_URL[p.judge]?.(p.id);
  $('detail-title').innerHTML = `<span class="pid">#${esc(p.id)}</span>${
    url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}`;
  const list = [...p.list].reverse();
  $('attempts').innerHTML = list.map((s, i) => `
    <li data-i="${i}">
      <div class="${verdictClass(s.verdict)}">${esc(verdictName(s.verdict))}${
        s.failed_testcase ? ` <span class="sub">#${s.failed_testcase}</span>` : ''}</div>
      <div class="sub">${fmtTime(s.submitted_at)} · ${s.max_time_ms ?? '-'}ms</div>
    </li>`).join('');
  $('attempts').onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) showAttempt(list[+li.dataset.i], li);
  };
  $('detail').showModal();
  showAttempt(list[0], $('attempts').firstElementChild);
}

async function showAttempt(s, li) {
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
  if (!li.classList.contains('active')) return; // 그 사이 다른 제출을 눌렀다

  const tcs = full.testcase_results || [];
  const lang = LANG_HL[s.language] ?? 'plaintext';
  let code = esc(full.source_code);
  if (window.hljs && full.source_code) {
    try { code = window.hljs.highlight(full.source_code, { language: lang }).value; } catch {}
  }

  view.innerHTML = `
    <div class="meta">
      <span class="${verdictClass(s.verdict)}">${esc(verdictName(s.verdict))}</span>
      <span>언어 <b>${esc(s.language ?? '-')}</b></span>
      <span>시간 <b>${s.max_time_ms ?? '-'}ms</b></span>
      <span>메모리 <b>${s.max_memory_kb != null ? Math.round(s.max_memory_kb / 1024) + 'MB' : '-'}</b></span>
      ${s.failed_testcase ? `<span>틀린 테스트케이스 <b>#${s.failed_testcase}</b></span>` : ''}
      ${s.contest_id ? `<span>대회 <b>${esc(s.contest_id)}</b></span>` : ''}
      <span>${fmtTime(s.submitted_at)}</span>
    </div>
    ${tcs.length ? `<h3>테스트케이스</h3><div class="tc">${tcs.map((t) =>
      `<span class="${verdictClass(t.verdict)}" title="${esc(verdictName(t.verdict))} · ${t.time_ms}ms">#${t.index + 1}</span>`).join('')}</div>` : ''}
    ${full.compile_output ? `<h3>채점 메시지</h3><pre class="plain">${esc(full.compile_output)}</pre>` : ''}
    <h3>코드</h3>
    <pre><code class="hljs language-${lang}">${code}</code></pre>`;
}

$('detail-close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
