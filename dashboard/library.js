// 코드 정리창: 문제 하나에 여러 풀이를 저장하고, 문제끼리 연결한다.
import {
  sb, $, esc, fmtTime, requireUser, loadProblems, linksOf,
  JUDGE_LABEL, LINK_KINDS, problemUrl, problemKey, shortLabel,
} from './shared.js';

const user = await requireUser();
let problems = [];
let solutions = [];
let links = [];
let current = null;      // 지금 보고 있는 문제
let editing = null;      // 편집 중인 풀이 (새로 만들면 null)
let explainTimer = null;

const params = new URLSearchParams(location.search);

async function refresh(keepSelection = true) {
  const data = await loadProblems({ fullSolutions: true });
  problems = data.problems;
  solutions = data.solutions;
  links = data.links;
  renderList();
  if (keepSelection && current) {
    const p = problems.find((x) => x.key === current.key);
    if (p) select(p, false);
  }
}

// ---------- 문제 목록 ----------
function renderList() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = problems.filter((p) => !q || p.id.includes(q) || p.title.toLowerCase().includes(q)
    || (JUDGE_LABEL[p.judge] ?? '').toLowerCase().includes(q));
  $('problem-list').innerHTML = rows.map((p) => `
    <button class="problem ${current?.key === p.key ? 'on' : ''}" data-key="${esc(p.key)}">
      <span class="pname">${p.judge === 'self' ? '<span class="tag">연습장</span>' : ''}<span class="pid">#${esc(p.id)}</span> ${esc(p.title)}</span>
      <span class="counts">${p.solutions ? `<span class="count">풀이 ${p.solutions}</span>` : ''}${p.links ? `<span class="count">연결 ${p.links}</span>` : ''}</span>
    </button>`).join('') || '<p class="muted small">문제가 없어요.</p>';
}
$('filter').addEventListener('input', renderList);
$('problem-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (b) select(problems.find((p) => p.key === b.dataset.key));
});

// ---------- 문제 상세 ----------
function select(p, pushUrl = true) {
  current = p;
  $('pick').hidden = true;
  $('content').hidden = false;
  renderList();
  if (pushUrl) {
    const url = `?judge=${encodeURIComponent(p.judge)}&problem=${encodeURIComponent(p.id)}`;
    history.replaceState(null, '', url);
  }
  $('problem-title').innerHTML = `${p.judge === 'self' ? '<span class="tag">연습장</span>' : ''}<span class="pid">#${esc(p.id)}</span> ${esc(p.title)}`;
  $('problem-link').href = problemUrl(p.judge, p.id);
  $('graph-link').href = `/graph.html?focus=${encodeURIComponent(p.key)}`;
  renderLinks();
  renderSolutions();
  renderLinkTargets();
}

function renderLinks() {
  const mine = linksOf(links, current.judge, current.id);
  $('links').innerHTML = mine.length ? mine.map((l) => `
    <div class="link-row">
      <span class="pill">${esc(LINK_KINDS[l.kind])}</span>
      <a href="?judge=${encodeURIComponent(l.judge)}&problem=${encodeURIComponent(l.id)}" data-goto="${esc(problemKey(l.judge, l.id))}">
        ${esc(shortLabel(l.judge, l.id))} ${esc(l.title ?? '')}</a>
      ${l.note ? `<span class="muted small">${esc(l.note)}</span>` : ''}
      <button class="ghost small" data-unlink="${l.row.id}">연결 끊기</button>
    </div>`).join('') : '<p class="muted small">아직 연결한 문제가 없어요. 확장 버전이나 비슷한 문제를 이어두면 나중에 같이 보여요.</p>';
}

$('links').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) {
    e.preventDefault();
    const p = problems.find((x) => x.key === go.dataset.goto);
    if (p) select(p);
    return;
  }
  const un = e.target.closest('[data-unlink]');
  if (!un) return;
  const { error } = await sb.from('problem_links').delete().eq('id', un.dataset.unlink);
  if (error) { alert(error.message); return; }
  await refresh();
});

function renderLinkTargets() {
  const connected = new Set(linksOf(links, current.judge, current.id).map((l) => problemKey(l.judge, l.id)));
  $('link-target').innerHTML = problems
    .filter((p) => p.key !== current.key && !connected.has(p.key))
    .map((p) => `<option value="${esc(p.key)}">${esc(shortLabel(p.judge, p.id))} ${esc(p.title)}</option>`).join('');
}

$('link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = problems.find((p) => p.key === $('link-target').value);
  if (!target) return;
  // extends = "상대가 이 문제의 확장 버전" 이므로 from=상대, to=현재로 저장하면 읽을 때 방향이 맞는다.
  const kind = $('link-kind').value;
  const row = kind === 'extends'
    ? { from_judge: target.judge, from_problem: target.id, from_title: target.title, to_judge: current.judge, to_problem: current.id, to_title: current.title, kind: 'base' }
    : { from_judge: current.judge, from_problem: current.id, from_title: current.title, to_judge: target.judge, to_problem: target.id, to_title: target.title, kind };
  const { error } = await sb.from('problem_links').insert({ owner_id: user.id, ...row, note: $('link-note').value.trim() });
  if (error) { alert(error.message.includes('duplicate') ? '이미 연결돼 있어요.' : error.message); return; }
  $('link-note').value = '';
  await refresh();
});

// ---------- 풀이 목록 ----------
function highlight(code, lang = 'cpp') {
  if (window.hljs) {
    try { return window.hljs.highlight(code, { language: lang }).value; } catch { /* 지원 안 하는 언어 */ }
  }
  return esc(code);
}

function renderSolutions() {
  const mine = solutionsOf(current).filter((s) => typeof s.code === 'string');
  $('solution-count').textContent = mine.length ? `${mine.length}개` : '';
  $('solutions').innerHTML = mine.length ? mine.map((s) => `
    <article class="solution">
      <div class="solution-head">
        <b>${esc(s.title || '(이름 없음)')}</b>
        ${s.complexity ? `<span class="pill muted">${esc(s.complexity)}</span>` : ''}
        ${s.explain_status === 'queued' || s.explain_status === 'running' ? '<span class="pill busy">Claude가 설명 쓰는 중…</span>' : ''}
        <span style="flex:1"></span>
        <button class="ghost small" data-copy="${s.id}">코드 복사</button>
        <button class="ghost small" data-edit="${s.id}">수정</button>
      </div>
      ${s.approach ? `<p>${esc(s.approach)}</p>` : ''}
      ${s.note ? `<p class="muted small note">${esc(s.note)}</p>` : ''}
      <details><summary class="muted small">코드 보기 (${s.code.split('\n').length}줄)</summary>
        <pre><code class="hljs language-${esc(s.language)}">${highlight(s.code, s.language)}</code></pre></details>
      <div class="muted small">${fmtTime(s.updated_at ?? s.created_at)}${s.source_submission_id ? ' · 제출에서 가져옴' : ''}</div>
    </article>`).join('') : '<p class="muted small">아직 정리한 풀이가 없어요. 같은 문제를 다른 방법으로 푼 코드를 모아두면 나중에 비교하기 좋아요.</p>';

  if (mine.some((s) => s.explain_status === 'queued' || s.explain_status === 'running')) {
    clearTimeout(explainTimer);
    explainTimer = setTimeout(() => refresh(), 5000);
  }
}

const solutionsOf = (p) => solutions.filter((s) => s.judge === p.judge && s.problem_id === p.id);

$('solutions').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const s = await fetchSolution(copy.dataset.copy);
    await navigator.clipboard.writeText(s.code).catch(() => {});
    copy.textContent = '복사됨';
    setTimeout(() => { copy.textContent = '코드 복사'; }, 1500);
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) openEditor(await fetchSolution(edit.dataset.edit));
});

async function fetchSolution(id) {
  const { data } = await sb.from('solutions').select('*').eq('id', id).single();
  return data;
}

// ---------- 풀이 편집 ----------
async function openEditor(solution) {
  editing = solution;
  $('editor-title').textContent = solution ? '풀이 수정' : '풀이 추가';
  $('s-title').value = solution?.title ?? '';
  $('s-code').value = solution?.code ?? '';
  $('s-approach').value = solution?.approach ?? '';
  $('s-complexity').value = solution?.complexity ?? '';
  $('s-note').value = solution?.note ?? '';
  $('delete-solution').hidden = !solution;
  $('editor-msg').hidden = true;
  await fillSubmissionPicker();
  $('editor-dialog').showModal();
}

// 이 문제에 낸 제출 중에서 코드를 가져올 수 있게 한다 (맞은 것부터).
async function fillSubmissionPicker() {
  const { data } = await sb.from('submissions')
    .select('submission_id,verdict,submitted_at,max_time_ms')
    .eq('judge', current.judge).eq('problem_id', current.id).order('submitted_at', { ascending: false });
  const rows = (data ?? []).filter((s) => s.verdict === 'Accepted').concat((data ?? []).filter((s) => s.verdict !== 'Accepted'));
  $('from-submission').innerHTML = '<option value="">직접 붙여넣기</option>'
    + rows.map((s) => `<option value="${esc(s.submission_id)}">${s.verdict === 'Accepted' ? '맞음' : '틀림'} · ${fmtTime(s.submitted_at)} · ${s.max_time_ms}ms</option>`).join('');
}

$('from-submission').addEventListener('change', async (e) => {
  if (!e.target.value) return;
  const { data } = await sb.from('submissions').select('source_code,language')
    .eq('judge', current.judge).eq('submission_id', e.target.value).single();
  if (data) $('s-code').value = data.source_code ?? '';
});

$('editor-close').addEventListener('click', () => $('editor-dialog').close());
$('add-solution').addEventListener('click', () => openEditor(null));

$('solution-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('s-code').value.trim();
  if (!code) { showEditorMsg('코드를 넣어주세요.', 'err'); return; }
  const row = {
    owner_id: user.id, judge: current.judge, problem_id: current.id, problem_title: current.title,
    title: $('s-title').value.trim(), code,
    approach: $('s-approach').value.trim(), complexity: $('s-complexity').value.trim(), note: $('s-note').value.trim(),
    source_submission_id: $('from-submission').value || editing?.source_submission_id || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = editing
    ? await sb.from('solutions').update(row).eq('id', editing.id)
    : await sb.from('solutions').insert(row);
  if (error) { showEditorMsg(error.message, 'err'); return; }
  $('editor-dialog').close();
  await refresh();
});

function showEditorMsg(text, kind = '') {
  $('editor-msg').textContent = text;
  $('editor-msg').className = `msg ${kind}`;
  $('editor-msg').hidden = !text;
}

// Claude에게 이름과 설명을 맡긴다. 먼저 저장한 뒤 요청하고, 다 되면 편집 창에 채워 넣는다.
$('explain').addEventListener('click', async () => {
  const code = $('s-code').value.trim();
  if (!code) { showEditorMsg('코드를 먼저 넣어주세요.', 'err'); return; }
  $('explain').disabled = true;
  showEditorMsg('먼저 저장하고 Claude에게 보낼게요…');
  const row = {
    owner_id: user.id, judge: current.judge, problem_id: current.id, problem_title: current.title,
    title: $('s-title').value.trim(), code, note: $('s-note').value.trim(),
    approach: $('s-approach').value.trim(), complexity: $('s-complexity').value.trim(),
    source_submission_id: $('from-submission').value || editing?.source_submission_id || null,
    explain_status: 'queued', updated_at: new Date().toISOString(),
  };
  const { data, error } = editing
    ? await sb.from('solutions').update(row).eq('id', editing.id).select().single()
    : await sb.from('solutions').insert(row).select().single();
  if (error) { showEditorMsg(error.message, 'err'); $('explain').disabled = false; return; }
  editing = data;
  $('delete-solution').hidden = false;
  showEditorMsg('Claude가 설명을 쓰는 중이에요… (20~40초)');

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: s } = await sb.from('solutions').select('*').eq('id', editing.id).single();
    if (!s || s.explain_status === 'queued' || s.explain_status === 'running') continue;
    if (s.explain_status === 'error') { showEditorMsg(`설명을 만들지 못했어요: ${s.explain_error}`, 'err'); break; }
    editing = s;
    $('s-title').value = s.title;
    $('s-approach').value = s.approach ?? '';
    $('s-complexity').value = s.complexity ?? '';
    $('s-note').value = s.note ?? '';
    showEditorMsg('Claude가 채웠어요. 고치고 저장하세요.', 'ok');
    break;
  }
  $('explain').disabled = false;
  refresh();
});

// 두 번 눌러야 지워진다.
$('delete-solution').addEventListener('click', async (e) => {
  const b = e.target;
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = '정말 삭제';
    setTimeout(() => { delete b.dataset.armed; b.textContent = '삭제'; }, 4000);
    return;
  }
  await sb.from('solutions').delete().eq('id', editing.id);
  delete b.dataset.armed;
  b.textContent = '삭제';
  $('editor-dialog').close();
  await refresh();
});

// ---------- 시작 ----------
await refresh(false);
const startKey = params.get('judge') && params.get('problem')
  ? `${params.get('judge')}:${params.get('problem')}` : null;
const start = startKey ? problems.find((p) => p.key === startKey) : null;
if (start) select(start, false);
