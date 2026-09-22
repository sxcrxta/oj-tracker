import { sb, $, esc, fmtTime, fmtMem, verdictName, verdictClass, requireUser, renderMarkdown } from './common.js';
import { judge, warm, TIME_FACTOR } from './judge.js';

const TEMPLATE = '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    return 0;\n}\n';

const { user } = await requireUser();
const id = Number(new URLSearchParams(location.search).get('id'));
const { data: problem } = await sb.from('oj_problems').select('*').eq('id', id).maybeSingle();
if (!problem) {
  $('title').textContent = '문제를 찾을 수 없어요';
  throw new Error('no problem');
}

// ---------- 문제 ----------
document.title = `${problem.id}. ${problem.title}`;
$('title').innerHTML = `<span class="muted">${problem.id}.</span> ${esc(problem.title)}${problem.published ? '' : ' <span class="pill draft">비공개</span>'}`;
$('limits').innerHTML = `
  <span>시간 제한 ${problem.time_limit_ms / 1000}초</span>
  <span>메모리 제한 ${Math.round(problem.memory_limit_kb / 1024)}MB</span>
  ${problem.difficulty ? `<span>${esc(problem.difficulty)}</span>` : ''}
  <span class="tags">${problem.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>`;

const fullStatement = `${problem.statement}\n\n## 입력\n\n${problem.input_spec}\n\n## 출력\n\n${problem.output_spec}`;
renderMarkdown($('statement'), fullStatement);
$('examples').innerHTML = problem.examples.map((e, i) => `
  <div class="ex">
    <div><div class="label">예제 입력 ${i + 1}</div><pre>${esc(e.input)}</pre></div>
    <div><div class="label">예제 출력 ${i + 1}</div><pre>${esc(e.output)}</pre></div>
  </div>`).join('') || '<p class="muted">예제가 없어요.</p>';

// ---------- 편집기 ----------
const draftKey = `oj-draft-${id}`;
let draft = null;
try { draft = localStorage.getItem(draftKey); } catch {}
const editor = window.CodeMirror.fromTextArea($('code'), {
  mode: 'text/x-c++src', lineNumbers: true, indentUnit: 4, tabSize: 4, matchBrackets: true,
  extraKeys: { Tab: (cm) => cm.replaceSelection('    ') },
});
editor.setValue(draft ?? TEMPLATE);
editor.on('change', () => { try { localStorage.setItem(draftKey, editor.getValue()); } catch {} });

// 컴파일러를 미리 받아둔다. 채점을 누르기 전에 대부분 끝나 있게.
warm((text) => { $('compiler').textContent = text; }, () => { $('compiler').textContent = '컴파일러 준비됨'; });

// ---------- 내 제출 ----------
async function loadMine() {
  const { data } = await sb.from('submissions')
    .select('verdict,max_time_ms,max_memory_kb,submitted_at,failed_testcase')
    .eq('judge', 'self').eq('problem_id', String(id)).order('submitted_at', { ascending: false });
  $('mine-empty').hidden = !!data?.length;
  $('mine').innerHTML = (data ?? []).map((s) => `<tr>
    <td class="${verdictClass(s.verdict)}">${esc(verdictName(s.verdict))}${s.failed_testcase ? ` <span class="muted small">#${s.failed_testcase}</span>` : ''}</td>
    <td class="num">${s.max_time_ms}ms</td>
    <td class="num">${fmtMem(s.max_memory_kb)}</td>
    <td class="muted">${fmtTime(s.submitted_at)}</td>
  </tr>`).join('');
}
loadMine();

// ---------- 채점 ----------
function showResult(html) {
  $('result').hidden = false;
  $('result').innerHTML = html;
}

function progressView(text, done, total) {
  showResult(`<div class="muted">${esc(text)}</div>${total ? `<div class="bar"><span style="width:${(done / total) * 100}%"></span></div><div class="muted small">${done} / ${total}</div>` : ''}`);
}

function resultView(r, { examples = false } = {}) {
  const failed = r.results.find((x) => x.verdict !== 'Accepted');
  const label = examples ? (r.verdict === 'Accepted' ? '예제를 모두 통과했어요' : verdictName(r.verdict)) : verdictName(r.verdict);
  let html = `<div class="big ${verdictClass(r.verdict)}">${esc(label)}</div>`;
  if (r.results.length) {
    html += `<div class="muted small">최대 ${r.maxTimeMs}ms · ${fmtMem(r.maxMemoryKb)}${failed ? ` · ${examples ? '예제' : '테스트케이스'} ${failed.index + 1}번에서 ${verdictName(failed.verdict)}` : ''}</div>`;
    html += `<div class="tc">${r.results.map((x) => `<span class="${verdictClass(x.verdict)}" title="${x.time_ms}ms">${x.index + 1}</span>`).join('')}</div>`;
  }
  if (examples && failed?.verdict === 'WrongAnswer') {
    const ex = problem.examples[failed.index];
    html += `<div class="ex" style="margin-top:8px"><div><div class="label">내 출력</div><pre>${esc(failed.stdout ?? '')}</pre></div><div><div class="label">기대 출력</div><pre>${esc(ex.output)}</pre></div></div>`;
  }
  if (r.compileOutput) html += `<pre class="plain">${esc(r.compileOutput)}</pre>`;
  return html;
}

function setBusy(busy) {
  $('submit').disabled = busy;
  $('run-examples').disabled = busy;
}

$('run-examples').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await judge({
      source: editor.getValue(), testcases: problem.examples,
      timeLimitMs: problem.time_limit_ms, memoryLimitKb: problem.memory_limit_kb, keepOutput: true,
      onStatus: (t) => progressView(t),
      onCase: (_res, total) => progressView('예제 실행 중…', _res.index + 1, total),
    });
    showResult(resultView(r, { examples: true }));
  } finally {
    setBusy(false);
  }
});

$('submit').addEventListener('click', async () => {
  setBusy(true);
  const source = editor.getValue();
  const submittedAt = new Date().toISOString();
  try {
    progressView('테스트케이스를 받는 중…');
    const { data: testcases, error } = await sb.from('oj_testcases').select('input,output').eq('problem_id', id).order('idx');
    if (error) throw error;
    const cases = testcases.length ? testcases : problem.examples; // 테스트케이스가 없으면 예제로 채점
    const r = await judge({
      source, testcases: cases, timeLimitMs: problem.time_limit_ms, memoryLimitKb: problem.memory_limit_kb,
      onStatus: (t) => progressView(t),
      onCase: (res, total) => progressView('채점 중…', res.index + 1, total),
    });
    if (r.verdict === 'JudgeError') { showResult(resultView(r)); return; }
    showResult(resultView(r));
    await saveSubmission(source, submittedAt, r, cases.length);
    loadMine();
  } catch (e) {
    showResult(`<div class="msg err">채점하지 못했어요: ${esc(e.message)}</div>`);
  } finally {
    setBusy(false);
  }
});

// dshs.app 기록과 같은 형식으로 저장해서 대시보드와 약점 분석이 그대로 쓰게 한다.
async function saveSubmission(source, submittedAt, r, testcaseCount) {
  const failed = r.results.find((x) => x.verdict !== 'Accepted');
  const { error } = await sb.from('submissions').insert({
    owner_id: user.id,
    judge: 'self',
    submission_id: crypto.randomUUID(),
    problem_id: String(problem.id),
    problem_title: problem.title,
    language: 'cpp',
    status: r.verdict === 'CompilationError' ? 'compilation_error' : 'completed',
    verdict: r.verdict,
    max_time_ms: r.maxTimeMs,
    max_memory_kb: r.maxMemoryKb,
    source_code: source,
    compile_output: r.compileOutput,
    testcase_results: r.results,
    failed_testcase: failed ? failed.index + 1 : null,
    submitted_at: submittedAt,
    raw: { judged_in: 'browser', time_factor: TIME_FACTOR },
  });
  if (error) throw new Error(`기록을 저장하지 못했어요: ${error.message}`);
  // 분석에 쓸 문제 설명도 내 계정에 저장해 둔다.
  await sb.from('problems').upsert({
    owner_id: user.id, judge: 'self', problem_id: String(problem.id), title: problem.title,
    statement: fullStatement, statement_has_images: false, examples: problem.examples,
    time_limit_ms: problem.time_limit_ms, memory_limit_kb: problem.memory_limit_kb,
    testcase_count: testcaseCount, tags: problem.tags, fetched_at: new Date().toISOString(),
  }, { onConflict: 'owner_id,judge,problem_id' });
}
