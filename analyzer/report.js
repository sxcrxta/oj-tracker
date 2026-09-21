// compare.js 결과 파일들을 합쳐서 모델별 분석을 나란히 보는 HTML을 만든다.
//   node report.js <출력.html> <결과.json...> [--notes notes.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { MISTAKE_TAGS } from './prompts.js';

const args = process.argv.slice(2);
const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? JSON.parse(readFileSync(args.splice(notesIdx, 2)[1], 'utf8')) : {};
const [outPath, ...files] = args;

// 여러 결과 파일을 문제 번호 기준으로 합친다.
const merged = { models: [], problems: new Map(), overall: {} };
for (const f of files) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  for (const m of r.models) if (!merged.models.includes(m)) merged.models.push(m);
  for (const p of r.problems) {
    const cur = merged.problems.get(p.problemId) || { ...p, analyses: {} };
    Object.assign(cur.analyses, p.analyses);
    merged.problems.set(p.problemId, cur);
  }
  Object.assign(merged.overall, r.overall);
}
const data = {
  models: merged.models,
  problems: [...merged.problems.values()],
  overall: merged.overall,
  tags: MISTAKE_TAGS,
  notes,
};

const html = `<title>분석 모델 비교</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">
<style>
:root {
  --bg: #f4f6f9; --surface: #ffffff; --sunken: #eaeef3; --fg: #16202c; --muted: #5d6b7c; --line: #d8dee6;
  --m0: #b45309; --m1: #1d4ed8; --m2: #047857; --m3: #7c3aed;
  --ac: #15803d; --wa: #dc2626; --tle: #c2410c; --re: #a16207; --ce: #7c3aed;
  --code-bg: #0f1722; --code-fg: #dbe3ee;
  --sans: "IBM Plex Sans KR", "Apple SD Gothic Neo", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d131b; --surface: #151d28; --sunken: #1b2533; --fg: #e4eaf2; --muted: #93a1b3; --line: #293545;
    --m0: #f59e0b; --m1: #60a5fa; --m2: #34d399; --m3: #a78bfa;
    --ac: #4ade80; --wa: #f87171; --tle: #fb923c; --re: #facc15; --ce: #a78bfa; --code-bg: #0a0f16;
  }
}
:root[data-theme="dark"] {
  --bg: #0d131b; --surface: #151d28; --sunken: #1b2533; --fg: #e4eaf2; --muted: #93a1b3; --line: #293545;
  --m0: #f59e0b; --m1: #60a5fa; --m2: #34d399; --m3: #a78bfa;
  --ac: #4ade80; --wa: #f87171; --tle: #fb923c; --re: #facc15; --ce: #a78bfa; --code-bg: #0a0f16;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font: 15px/1.65 var(--sans); padding-inline: 16px; }
.wrap { max-width: 1240px; margin: 0 auto; padding-block: 28px 64px; display: grid; gap: 22px; }
h1 { font-size: 24px; margin: 0; text-wrap: balance; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0; }
.lede { color: var(--muted); margin: 6px 0 0; max-width: 70ch; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }

.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: .03em; background: var(--sunken); }
td.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
.model { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--c); flex: none; }

.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tab { font: inherit; font-size: 14px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
.tab[aria-selected="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.tab:focus-visible, summary:focus-visible { outline: 2px solid var(--m1); outline-offset: 2px; }
.tab .mono { font-size: 12px; opacity: .75; margin-right: 4px; }

.problem-head { display: grid; gap: 10px; }
.flow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip { font-size: 12.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid currentColor; font-weight: 500; }
.arrow { color: var(--muted); font-size: 12px; }
.v-Accepted { color: var(--ac); } .v-WrongAnswer { color: var(--wa); } .v-TimeLimitExceeded { color: var(--tle); }
.v-RuntimeError { color: var(--re); } .v-CompilationError { color: var(--ce); }
details.code { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
details.code > summary { cursor: pointer; padding: 10px 14px; color: var(--muted); font-size: 14px; }
.subs { display: grid; gap: 10px; padding: 0 14px 14px; }
.sub-title { font-size: 13px; margin-bottom: 4px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
pre { margin: 0; background: var(--code-bg); color: var(--code-fg); padding: 12px 14px; border-radius: 8px; overflow-x: auto; font: 12.5px/1.55 var(--mono); }

.note { border-left: 3px solid var(--fg); background: var(--surface); padding: 12px 16px; border-radius: 0 10px 10px 0; }
.note b { display: block; font-size: 12px; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; font-weight: 600; }

.cols { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 14px; align-items: start; }
.col { background: var(--surface); border: 1px solid var(--line); border-top: 3px solid var(--c); border-radius: 10px; padding: 14px 16px; display: grid; gap: 12px; min-width: 0; }
.col-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.conf { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--sunken); color: var(--muted); }
.conf.high { color: var(--ac); } .conf.low { color: var(--wa); }
.label { font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: .03em; margin-bottom: 2px; }
.col p { margin: 0; }
.col ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.tag { display: inline-block; font-size: 11.5px; padding: 1px 7px; border-radius: 4px; background: var(--sunken); color: var(--fg); margin-right: 4px; white-space: nowrap; }
.issues { font-size: 12.5px; color: var(--wa); }
.err { color: var(--wa); font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.meta { font-size: 12px; color: var(--muted); font-family: var(--mono); }

@media (max-width: 860px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>

<div class="wrap">
  <header>
    <h1>Gemma로 충분할까? 분석 모델 비교</h1>
    <p class="lede">dshs.app에서 예전에 낸 제출 ${data.problems.length}문제를 각 모델에 똑같이 넣고, 문제별로 어디서 왜 틀렸는지 분석하게 했습니다. 같은 입력, 같은 출력 형식이라 결과만 나란히 비교하면 됩니다.</p>
  </header>
  <section id="summary"></section>
  <nav class="tabs" id="tabs" role="tablist"></nav>
  <section id="view"></section>
</div>

<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const V = { Accepted: '맞았습니다', WrongAnswer: '틀렸습니다', TimeLimitExceeded: '시간 초과', MemoryLimitExceeded: '메모리 초과', RuntimeError: '런타임 에러', CompilationError: '컴파일 에러' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const color = (i) => 'var(--m' + (i % 4) + ')';
const modelLabel = (m) => m.replace('claude-cli:', 'Claude ').replace('openrouter:', '').replace('google/', '').replace('google:', '');
const tagName = (t) => DATA.tags[t] || t;
const $ = (id) => document.getElementById(id);

function renderSummary() {
  const rows = DATA.models.map((m, i) => {
    const rs = DATA.problems.map((p) => p.analyses[m]).filter(Boolean);
    const ok = rs.filter((r) => r.output);
    const fail = rs.length - ok.length;
    const issues = ok.reduce((n, r) => n + (r.issues?.length || 0), 0);
    const avg = ok.length ? Math.round(ok.reduce((n, r) => n + (r.meta?.ms || 0), 0) / ok.length / 100) / 10 : null;
    const conf = { high: 0, medium: 0, low: 0 };
    ok.forEach((r) => conf[r.output.confidence] = (conf[r.output.confidence] || 0) + 1);
    const verdict = DATA.notes.models?.[m];
    return '<tr><td><span class="model" style="--c:' + color(i) + '"><span class="swatch"></span>' + esc(modelLabel(m)) + '</span></td>'
      + '<td class="num">' + ok.length + ' / ' + rs.length + '</td>'
      + '<td class="num">' + issues + '</td>'
      + '<td class="num">' + (avg ?? '-') + 's</td>'
      + '<td class="num">' + conf.high + ' / ' + conf.medium + ' / ' + conf.low + '</td>'
      + '<td style="white-space:normal;min-width:220px">' + esc(verdict || '') + '</td></tr>';
  }).join('');
  $('summary').innerHTML = '<div class="scroll"><table><thead><tr><th>모델</th><th>성공</th><th>형식 오류</th><th>평균 시간</th><th>확신 높음/중간/낮음</th><th>판정</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + (DATA.notes.summary ? '<div class="note" style="margin-top:14px"><b>검토 결과</b>' + esc(DATA.notes.summary) + '</div>' : '');
}

const tabs = [...DATA.problems.map((p) => ({ id: 'p' + p.problemId, label: '<span class="mono">#' + p.problemId + '</span>' + esc(p.title) })), { id: 'overall', label: '종합 리포트' }];
let current = tabs[0].id;
try { current = localStorage.getItem('tab') || current; } catch {}
if (!tabs.some((t) => t.id === current)) current = tabs[0].id;

function renderTabs() {
  $('tabs').innerHTML = tabs.map((t) => '<button class="tab" role="tab" id="tab-' + t.id + '" aria-selected="' + (t.id === current) + '" data-id="' + t.id + '">' + t.label + '</button>').join('');
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  current = b.dataset.id;
  try { localStorage.setItem('tab', current); } catch {}
  renderTabs(); renderView();
});

function analysisCol(m, i, r, p) {
  const head = '<div class="col-head"><span class="model"><span class="swatch"></span>' + esc(modelLabel(m)) + '</span>'
    + (r?.output ? '<span class="conf ' + esc(r.output.confidence) + '">확신 ' + esc(r.output.confidence) + '</span>' : '') + '</div>';
  if (!r) return '<div class="col" style="--c:' + color(i) + '">' + head + '<p class="muted">결과 없음</p></div>';
  if (r.error) return '<div class="col" style="--c:' + color(i) + '">' + head + '<div class="err">' + esc(r.error) + '</div></div>';
  const o = r.output;
  const attempts = (o.attempts || []).map((a) => {
    const s = p.submissions[a.n - 1];
    return '<li><span class="mono muted">제출 ' + a.n + (s ? ' · ' + esc(V[s.verdict] || s.verdict) : '') + '</span> <span class="tag">' + esc(tagName(a.tag)) + '</span><br>' + esc(a.cause) + '</li>';
  }).join('');
  const weak = (o.weak_points || []).map((w) => '<li><span class="tag">' + esc(tagName(w.tag)) + '</span>' + esc(w.description) + '</li>').join('');
  return '<div class="col" style="--c:' + color(i) + '">' + head
    + '<div><div class="label">요약</div><p>' + esc(o.summary) + '</p></div>'
    + (attempts ? '<div><div class="label">틀린 제출별 원인</div><ul>' + attempts + '</ul></div>' : '')
    + '<div><div class="label">맞게 된 수정</div><p>' + (o.fix_point ? esc(o.fix_point) : '<span class="muted">아직 못 풂</span>') + '</p></div>'
    + (weak ? '<div><div class="label">드러난 약점</div><ul>' + weak + '</ul></div>' : '')
    + '<div><div class="label">다음에 확인할 것</div><p>' + esc(o.advice) + '</p></div>'
    + (r.issues?.length ? '<div class="issues">형식 문제: ' + esc(r.issues.join(', ')) + '</div>' : '')
    + '<div class="meta">' + (r.meta?.ms ? (r.meta.ms / 1000).toFixed(1) + 's' : '') + '</div>'
    + '</div>';
}

function renderProblem(p) {
  const flow = p.submissions.map((s) => '<span class="chip v-' + s.verdict + '">' + esc(V[s.verdict] || s.verdict) + '</span>').join('<span class="arrow">→</span>');
  const subs = p.submissions.map((s, i) => {
    const failed = s.testcases.find((t) => t.verdict !== 'Accepted');
    const same = p.submissions.findIndex((x) => x.code === s.code);
    return '<div><div class="sub-title"><b>제출 ' + (i + 1) + '</b><span class="v-' + s.verdict + '">' + esc(V[s.verdict] || s.verdict) + '</span>'
      + (failed ? '<span class="muted mono">' + failed.n + '번 케이스</span>' : '')
      + (same !== i ? '<span class="muted">제출 ' + (same + 1) + '과 같은 코드</span>' : '') + '</div>'
      + '<pre>' + esc(s.code) + '</pre>'
      + (s.compileOutput ? '<pre style="margin-top:6px">' + esc(s.compileOutput) + '</pre>' : '') + '</div>';
  }).join('');
  const note = DATA.notes.problems?.[p.problemId];
  return '<div class="problem-head"><h2><span class="mono muted">#' + p.problemId + '</span> ' + esc(p.title) + '</h2>'
    + '<div class="flow">' + flow + '</div>'
    + '<details class="code"><summary>문제 설명과 제출 코드 ' + p.submissions.length + '개 보기</summary><div class="subs">'
    + '<div><div class="sub-title"><b>문제</b><span class="muted mono">' + p.timeLimitMs + 'ms · 테스트케이스 ' + p.testcaseCount + '개</span></div><pre style="white-space:pre-wrap;font-family:var(--sans)">' + esc(p.statement) + '</pre></div>'
    + subs + '</div></details>'
    + (note ? '<div class="note"><b>실제 원인 (Claude가 코드를 직접 검토)</b>' + esc(note) + '</div>' : '')
    + '</div>'
    + '<div class="cols" style="--n:' + DATA.models.length + ';margin-top:16px">' + DATA.models.map((m, i) => analysisCol(m, i, p.analyses[m], p)).join('') + '</div>';
}

function renderOverall() {
  return '<div class="cols" style="--n:' + DATA.models.length + '">' + DATA.models.map((m, i) => {
    const r = DATA.overall[m];
    const head = '<div class="col-head"><span class="model"><span class="swatch"></span>' + esc(modelLabel(m)) + '</span></div>';
    if (!r || r.error) return '<div class="col" style="--c:' + color(i) + '">' + head + '<div class="err">' + esc(r?.error || '결과 없음') + '</div></div>';
    const o = r.output;
    const weak = (o.top_weaknesses || []).map((w) => '<li><b>' + esc(w.title) + '</b> <span class="tag">' + esc(tagName(w.tag)) + '</span><br>' + esc(w.description)
      + '<br><span class="muted">근거: ' + esc((w.problems || []).map((x) => '#' + String(x).replace('#', '')).join(', ')) + '</span><br><span class="muted">연습:</span> ' + esc(w.practice) + '</li>').join('');
    return '<div class="col" style="--c:' + color(i) + '">' + head
      + '<div><div class="label">전체 경향</div><p>' + esc(o.overview) + '</p></div>'
      + '<div><div class="label">주요 약점</div><ul>' + weak + '</ul></div>'
      + '<div><div class="label">강점</div><ul>' + (o.strengths || []).map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul></div>'
      + '<div><div class="label">다음 할 일</div><ul>' + (o.next_steps || []).map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul></div>'
      + '</div>';
  }).join('') + '</div>';
}

function renderView() {
  const p = DATA.problems.find((x) => 'p' + x.problemId === current);
  $('view').innerHTML = p ? renderProblem(p) : renderOverall();
}

renderSummary(); renderTabs(); renderView();
</script>
`;

writeFileSync(outPath, html);
console.log(`저장: ${outPath}`);
