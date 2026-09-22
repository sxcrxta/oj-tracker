import { sb, $, esc, fmtTime, requireUser } from './common.js';

const { isAdmin } = await requireUser();
if (!isAdmin) {
  document.querySelector('main').innerHTML = '<p class="muted center">관리자만 볼 수 있어요.</p>';
  throw new Error('not admin');
}

let problems = [];
let current = null;
let jobs = [];
let jobTimer = null;

// ---------- Claude 워커 상태 ----------
async function loadWorker() {
  const { data } = await sb.from('claude_workers').select('*').maybeSingle();
  const online = data && Date.now() - Date.parse(data.last_seen) < 90_000;
  $('worker').textContent = online ? 'Claude 워커 연결됨' : data ? 'Claude 워커 꺼짐 — 켜야 문제를 만들어요' : 'Claude 워커 미연결 — 대시보드에서 연결하세요';
}

// ---------- 문제 만들기 요청 ----------
$('gen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gen-submit').disabled = true;
  const request = {
    topic: $('gen-topic').value.trim(),
    difficulty: $('gen-difficulty').value,
    notes: $('gen-notes').value.trim(),
    use_weakness: $('gen-weak').checked,
  };
  const { error } = await sb.from('oj_problem_jobs').insert({ request });
  $('gen-submit').disabled = false;
  if (error) { alert(`요청하지 못했어요: ${error.message}`); return; }
  $('gen-topic').value = '';
  $('gen-notes').value = '';
  loadJobs();
});

async function loadJobs() {
  const { data } = await sb.from('oj_problem_jobs').select('*').order('created_at', { ascending: false }).limit(8);
  const finished = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
    .some((j) => data.find((d) => d.id === j.id)?.status === 'done');
  jobs = data ?? [];
  const label = { queued: '대기', running: '만드는 중…', done: '완료', error: '실패' };
  $('jobs').innerHTML = jobs.map((j) => `
    <div class="job">
      <span class="pill ${j.status === 'error' ? 'draft' : 'muted'}">${label[j.status]}</span>
      <span>${esc(j.request.topic)} · ${esc(j.request.difficulty)}</span>
      ${j.problem_id ? `<a href="#" data-open="${j.problem_id}">#${j.problem_id} 열기</a>` : ''}
      <span class="muted small">${fmtTime(j.created_at)}</span>
      ${j.error ? `<div class="muted small" style="width:100%">${esc(j.error)}</div>` : ''}
    </div>`).join('');
  if (finished) await loadProblems();
  clearTimeout(jobTimer);
  if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) jobTimer = setTimeout(() => { loadJobs(); loadWorker(); }, 5000);
}
$('jobs').addEventListener('click', (e) => {
  const a = e.target.closest('[data-open]');
  if (!a) return;
  e.preventDefault();
  openProblem(Number(a.dataset.open));
});

// ---------- 문제 목록 ----------
async function loadProblems() {
  const { data, error } = await sb.from('oj_problems').select('id,title,published,source').order('id', { ascending: false });
  if (error) { alert(error.message); return; }
  problems = data;
  $('plist').innerHTML = problems.map((p) => `<tr data-id="${p.id}">
    <td class="num">${p.id}</td>
    <td>${esc(p.title)} ${p.source === 'claude' ? '<span class="tag">Claude</span>' : ''}</td>
    <td>${p.published ? '<span class="pill muted">공개</span>' : '<span class="pill draft">비공개</span>'}</td>
  </tr>`).join('');
}
$('plist').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openProblem(Number(tr.dataset.id));
});

$('new-problem').addEventListener('click', async () => {
  const { data, error } = await sb.from('oj_problems').insert({ title: '새 문제' }).select().single();
  if (error) { alert(error.message); return; }
  await loadProblems();
  openProblem(data.id);
});

// ---------- 편집 ----------
function exampleRow(e = { input: '', output: '' }) {
  const div = document.createElement('div');
  div.className = 'grid2 example-row';
  div.innerHTML = `<label>예제 입력<textarea class="ex-in">${esc(e.input)}</textarea></label>
    <label>예제 출력<textarea class="ex-out">${esc(e.output)}</textarea></label>
    <div style="grid-column:1/-1"><button type="button" class="ghost small ex-del">이 예제 빼기</button></div>`;
  div.querySelector('.ex-del').addEventListener('click', () => div.remove());
  $('f-examples').appendChild(div);
}
$('add-example').addEventListener('click', () => exampleRow());

async function openProblem(id) {
  const [{ data: p }, { data: priv }, { count }] = await Promise.all([
    sb.from('oj_problems').select('*').eq('id', id).single(),
    sb.from('oj_problem_private').select('*').eq('problem_id', id).maybeSingle(),
    sb.from('oj_testcases').select('idx', { count: 'exact', head: true }).eq('problem_id', id),
  ]);
  if (!p) return;
  current = p;
  $('editor-empty').hidden = true;
  $('edit-form').hidden = false;
  $('edit-heading').textContent = `#${p.id} 편집`;
  $('edit-open').href = `problem.html?id=${p.id}`;
  $('edit-publish').textContent = p.published ? '비공개로 전환' : '공개하기';
  $('f-title').value = p.title;
  $('f-difficulty').value = p.difficulty ?? '';
  $('f-tl').value = p.time_limit_ms;
  $('f-ml').value = Math.round(p.memory_limit_kb / 1024);
  $('f-tags').value = p.tags.join(', ');
  $('f-statement').value = p.statement;
  $('f-input').value = p.input_spec;
  $('f-output').value = p.output_spec;
  $('f-examples').innerHTML = '';
  p.examples.forEach(exampleRow);
  $('f-testcases').textContent = count
    ? `채점용 테스트케이스 ${count}개 (예제와 별개). 테스트케이스는 Claude 워커가 만든 것을 그대로 써요.`
    : '채점용 테스트케이스가 없어요. 테스트케이스가 없으면 제출은 예제만으로 채점돼요.';
  $('f-private').hidden = !priv;
  if (priv) {
    $('f-solution').textContent = priv.solution_code ?? '';
    $('f-generator').textContent = priv.generator_code ?? '';
    $('f-notes').textContent = priv.notes ?? '';
  }
  resetDelete();
}

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const examples = [...document.querySelectorAll('.example-row')].map((row) => ({
    input: row.querySelector('.ex-in').value, output: row.querySelector('.ex-out').value,
  }));
  const patch = {
    title: $('f-title').value.trim(),
    difficulty: $('f-difficulty').value.trim() || null,
    time_limit_ms: Number($('f-tl').value) || 1000,
    memory_limit_kb: (Number($('f-ml').value) || 256) * 1024,
    tags: $('f-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    statement: $('f-statement').value,
    input_spec: $('f-input').value,
    output_spec: $('f-output').value,
    examples,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('oj_problems').update(patch).eq('id', current.id);
  if (error) { alert(`저장하지 못했어요: ${error.message}`); return; }
  await loadProblems();
  await openProblem(current.id);
});

$('edit-publish').addEventListener('click', async () => {
  const { error } = await sb.from('oj_problems').update({ published: !current.published, updated_at: new Date().toISOString() }).eq('id', current.id);
  if (error) { alert(error.message); return; }
  await loadProblems();
  await openProblem(current.id);
});

// 두 번 눌러야 지워진다.
function resetDelete() {
  const b = $('edit-delete');
  delete b.dataset.armed;
  b.textContent = b.dataset.label;
  b.classList.remove('danger-armed');
}
$('edit-delete').addEventListener('click', async () => {
  const b = $('edit-delete');
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = '정말 삭제 (제출 기록은 남아요)';
    b.classList.add('danger-armed');
    setTimeout(() => { if (b.dataset.armed) resetDelete(); }, 4000);
    return;
  }
  const { error } = await sb.from('oj_problems').delete().eq('id', current.id);
  if (error) { alert(error.message); return; }
  current = null;
  $('edit-form').hidden = true;
  $('editor-empty').hidden = false;
  loadProblems();
});

loadWorker();
loadJobs();
loadProblems();
