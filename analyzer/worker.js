#!/usr/bin/env node
// 로컬 Claude 워커: 대시보드에서 "Claude 분석"으로 넘어온 요청을 내 컴퓨터의 Claude Code로 처리한다.
//
//   node worker.js link <코드>  대시보드의 "Claude 연결"에서 받은 코드로 연결 (한 번만)
//   node worker.js login     또는 이메일/비밀번호로 로그인
//   node worker.js           워커 실행 (켜두는 동안 요청을 처리)
//   node worker.js logout    로그아웃하고 Claude 연결 해제
//
// 옵션: --model sonnet|opus|haiku (기본 sonnet)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { claudeCli } from './providers.js';
import { generateProblem } from './problem-gen.js';
import {
  HINT_SYSTEM, LEVEL_SCHEMA, CODE_SCHEMA, levelPrompt, codePrompt, normalizeLevelHint, normalizeCodeHint,
} from '../supabase/functions/_shared/hints.js';
import { EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, explainPrompt, normalizeExplain } from '../supabase/functions/_shared/solutions.js';
import {
  SYSTEM_PROMPT, PROBLEM_SCHEMA, OVERALL_SCHEMA, problemPrompt, overallPrompt,
  toInput, normalizeProblemOutput, normalizeOverallOutput, buildOverallInputs,
} from './prompts.js';

const SUPABASE_URL = 'https://uciyqapuzugedebycbmz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_uArKEThfy_wUXWMTceVBdQ_L9SBF6b4';
const SESSION_DIR = join(homedir(), '.config', 'oj-analyzer');
const SESSION_FILE = join(SESSION_DIR, 'session.json');
const POLL_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const STALE_RUNNING_MS = 15 * 60_000;

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'run';
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet';
const log = (...m) => console.log(`[${new Date().toLocaleTimeString('ko-KR')}]`, ...m);

// ---------- 인증 ----------
async function auth(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `인증 실패 (${res.status})`);
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at * 1000, user: { id: data.user.id, email: data.user.email } };
}

function saveSession(s) {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify(s), { mode: 0o600 });
}

let session = null;
let refreshing = null;
async function token() {
  if (!session) {
    if (!existsSync(SESSION_FILE)) throw new Error('먼저 연결하세요: 대시보드의 "Claude 연결"에서 코드를 받아 `node worker.js link <코드>`');
    session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  }
  if (session.expires_at - Date.now() < 120_000) {
    // 하트비트와 작업 처리가 동시에 갱신하면 토큰이 두 번 쓰이므로 한 번만 갱신한다.
    refreshing ||= auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then((s) => { session = s; saveSession(s); })
      .catch((e) => {
        if (/refresh token/i.test(e.message)) {
          throw Object.assign(new Error('연결이 끊겼어요. 대시보드의 "Claude 연결"에서 새 코드를 받아 `node worker.js link <코드>`로 다시 연결하세요.'), { authLost: true });
        }
        throw e;
      })
      .finally(() => { refreshing = null; });
    await refreshing;
  }
  return session.access_token;
}

// ---------- DB (PostgREST) ----------
async function db(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${method} ${path.split('?')[0]} 실패 (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const q = encodeURIComponent;

// ---------- 명령 ----------
function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) console.log(); resolve(a.trim()); }));
}

async function login() {
  console.log('대시보드(확장 프로그램)와 같은 계정으로 로그인하세요.');
  const email = await ask('이메일: ');
  const password = await ask('비밀번호: ', { hidden: true });
  session = await auth('token?grant_type=password', { email, password });
  saveSession(session);
  console.log(`로그인했어요 (${session.user.email}). 이제 \`node worker.js\`로 워커를 켜세요.`);
}

// 대시보드에서 받은 일회용 코드로 로그인한다. 비밀번호를 입력할 필요가 없다.
async function link() {
  const code = args.filter((a) => !a.startsWith('--'))[1];
  if (!code) throw new Error('사용법: node worker.js link <코드>  (대시보드의 "Claude 연결"에서 코드를 받으세요)');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/worker-link`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'redeem', code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `연결 실패 (${res.status})`);
  session = await auth('verify', { type: 'magiclink', token_hash: data.token_hash });
  saveSession(session);
  console.log(`연결했어요 (${session.user.email}). 이제 \`node worker.js\`로 워커를 켜세요.`);
}

async function logout() {
  if (existsSync(SESSION_FILE)) {
    // Claude 연결 기록을 지워서, 이후 어려운 문제가 다시 "Claude 분석 필요"로 표시되게 한다.
    await db('claude_workers?owner_id=not.is.null', { method: 'DELETE' }).catch(() => {});
    rmSync(SESSION_FILE);
  }
  console.log('로그아웃했어요. Claude 연결도 해제됐어요.');
}

function checkClaude() {
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
    log(`Claude Code ${v}, 모델 ${model}`);
  } catch {
    throw new Error('Claude Code(claude 명령)를 찾을 수 없어요. https://claude.com/claude-code 에서 설치하고 로그인하세요.');
  }
}

async function heartbeat() {
  await db('claude_workers?on_conflict=owner_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: { owner_id: session.user.id, model, last_seen: new Date().toISOString() },
  });
}

// ---------- 분석 ----------
async function analyzeProblem(row) {
  const subs = await db(`submissions?select=submission_id,problem_title,verdict,submitted_at,max_time_ms,max_memory_kb,testcase_results,compile_output,source_code&judge=eq.${q(row.judge)}&problem_id=eq.${q(row.problem_id)}&order=submitted_at`);
  if (!subs.length) throw new Error('제출 기록이 없어요');
  const [problem] = await db(`problems?judge=eq.${q(row.judge)}&problem_id=eq.${q(row.problem_id)}`);
  const input = toInput(problem, subs, { problemId: row.problem_id });
  const { output } = await claudeCli({ model }).analyze({ system: SYSTEM_PROMPT, prompt: problemPrompt(input), schema: PROBLEM_SCHEMA });
  return { result: normalizeProblemOutput(output, input), submission_ids: subs.map((s) => s.submission_id) };
}

async function analyzeOverall() {
  const [subs, analyses] = await Promise.all([
    db('submissions?select=judge,submission_id,problem_id,problem_title,verdict,submitted_at'),
    db('analyses?select=judge,problem_id,kind,status,result,created_at&kind=eq.problem'),
  ]);
  const { done, pending } = buildOverallInputs(subs, analyses);
  if (!done.length) throw new Error('먼저 문제별 분석이 하나 이상 끝나야 해요');
  const { output } = await claudeCli({ model }).analyze({ system: SYSTEM_PROMPT, prompt: overallPrompt(done, pending), schema: OVERALL_SCHEMA });
  return { result: normalizeOverallOutput(output), submission_ids: subs.map((s) => s.submission_id) };
}

async function processNext() {
  const [row] = await db('analyses?engine=eq.claude&status=eq.queued&order=created_at&limit=1');
  if (!row) return false;
  // 다른 워커(다른 컴퓨터)가 먼저 가져가지 않았을 때만 처리한다.
  const claimed = await db(`analyses?id=eq.${row.id}&status=eq.queued`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { status: 'running', model: `claude-${model}`, updated_at: new Date().toISOString() },
  });
  if (!claimed.length) return true;

  const label = row.kind === 'overall' ? '종합 리포트' : `#${row.problem_id}`;
  log(`${label} 분석 시작`);
  const started = Date.now();
  let patch;
  try {
    patch = { status: 'done', error: null, ...(row.kind === 'overall' ? await analyzeOverall() : await analyzeProblem(row)) };
    log(`${label} 완료 (${Math.round((Date.now() - started) / 1000)}초)`);
  } catch (e) {
    patch = { status: 'error', error: e.message.slice(0, 500) };
    log(`${label} 실패: ${e.message}`);
  }
  await db(`analyses?id=eq.${row.id}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } });
  return true;
}

// 정리해 둔 풀이에 Claude가 이름과 설명을 붙인다.
async function processSolutionExplain() {
  const [row] = await db('solutions?explain_status=eq.queued&order=updated_at&limit=1');
  if (!row) return false;
  const claimed = await db(`solutions?id=eq.${row.id}&explain_status=eq.queued`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { explain_status: 'running', updated_at: new Date().toISOString() },
  });
  if (!claimed.length) return true;

  const label = `${row.judge} #${row.problem_id} 풀이 설명`;
  log(`${label} 시작`);
  let patch;
  try {
    const [problem, others] = await Promise.all([
      loadProblemForHint(row.judge, row.problem_id),
      db(`solutions?select=title,approach&judge=eq.${q(row.judge)}&problem_id=eq.${q(row.problem_id)}&id=neq.${row.id}`),
    ]);
    if (!problem) throw new Error('문제 내용을 찾지 못했어요. 문제 페이지를 한 번 열었다가 다시 시도해 보세요.');
    const { output } = await claudeCli({ model }).analyze({
      system: EXPLAIN_SYSTEM, schema: EXPLAIN_SCHEMA,
      prompt: explainPrompt({ problem, solution: row, otherSolutions: others }),
    });
    const e = normalizeExplain(output);
    patch = {
      explain_status: 'done', explain_error: null,
      title: row.title?.trim() ? row.title : e.title,   // 내가 지은 이름이 있으면 그대로 둔다
      approach: e.approach, complexity: e.complexity,
      note: [row.note, e.key_points.map((k) => `- ${k}`).join('\n')].filter((x) => x && x.trim()).join('\n'),
    };
    log(`${label} 완료`);
  } catch (e) {
    patch = { explain_status: 'error', explain_error: e.message.slice(0, 300) };
    log(`${label} 실패: ${e.message}`);
  }
  await db(`solutions?id=eq.${row.id}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } });
  return true;
}

// 힌트에 쓸 문제 정보. dshs 문제는 확장 프로그램이 저장해 둔 problems, 연습장 문제는 oj_problems에서 읽는다.
async function loadProblemForHint(judge, problemId) {
  const [saved] = await db(`problems?judge=eq.${q(judge)}&problem_id=eq.${q(problemId)}`);
  if (saved) return saved;
  if (judge !== 'self') return null;
  const [p] = await db(`oj_problems?id=eq.${q(problemId)}`);
  if (!p) return null;
  return {
    judge, problem_id: String(p.id), title: p.title,
    statement: `${p.statement}\n\n## 입력\n\n${p.input_spec}\n\n## 출력\n\n${p.output_spec}`,
    statement_has_images: false, examples: p.examples,
    time_limit_ms: p.time_limit_ms, memory_limit_kb: p.memory_limit_kb,
  };
}

// 문제를 푸는 중에 요청한 힌트를 처리한다.
async function processHint() {
  const [row] = await db('hints?status=eq.queued&order=created_at&limit=1');
  if (!row) return false;
  const claimed = await db(`hints?id=eq.${row.id}&status=eq.queued`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { status: 'running', model: `claude-${model}`, updated_at: new Date().toISOString() },
  });
  if (!claimed.length) return true;

  const label = `${row.judge} #${row.problem_id} ${row.kind === 'code' ? '코드 진단' : `${row.level}단계 힌트`}`;
  log(`${label} 시작`);
  let patch;
  try {
    const [problem, submissions, previous] = await Promise.all([
      loadProblemForHint(row.judge, row.problem_id),
      db(`submissions?select=verdict,submitted_at,testcase_results,compile_output&judge=eq.${q(row.judge)}&problem_id=eq.${q(row.problem_id)}&order=submitted_at`),
      db(`hints?select=level,result,status&judge=eq.${q(row.judge)}&problem_id=eq.${q(row.problem_id)}&kind=eq.level&status=eq.done&order=level`),
    ]);
    if (!problem) throw new Error('문제 내용을 찾지 못했어요. 문제 페이지를 한 번 열었다가 다시 시도해 보세요.');
    const claude = claudeCli({ model });
    const { output } = row.kind === 'code'
      ? await claude.analyze({
        system: HINT_SYSTEM, schema: CODE_SCHEMA,
        prompt: codePrompt({ problem, submissions, code: row.code ?? '', lastSubmission: submissions.at(-1) }),
      })
      : await claude.analyze({
        system: HINT_SYSTEM, schema: LEVEL_SCHEMA,
        prompt: levelPrompt({
          problem, submissions, level: row.level,
          previousHints: previous.filter((h) => h.level < row.level).map((h) => h.result?.hint).filter(Boolean),
        }),
      });
    patch = { status: 'done', error: null, result: row.kind === 'code' ? normalizeCodeHint(output) : normalizeLevelHint(output) };
    log(`${label} 완료`);
  } catch (e) {
    patch = { status: 'error', error: e.message.slice(0, 500) };
    log(`${label} 실패: ${e.message}`);
  }
  await db(`hints?id=eq.${row.id}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } });
  return true;
}

// 연습장 관리자의 "Claude로 문제 만들기" 요청을 처리한다. (관리자가 아니면 RLS 때문에 항상 빈 목록)
async function processProblemJob() {
  const [job] = await db('oj_problem_jobs?status=eq.queued&order=created_at&limit=1');
  if (!job) return false;
  const claimed = await db(`oj_problem_jobs?id=eq.${job.id}&status=eq.queued`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'running', updated_at: new Date().toISOString() },
  });
  if (!claimed.length) return true;
  log(`문제 만들기 시작: ${job.request.topic} (${job.request.difficulty})`);
  const started = Date.now();
  let patch;
  try {
    const problemId = await generateProblem(job, { analyze: claudeCli({ model }).analyze, db, log });
    patch = { status: 'done', problem_id: problemId, error: null };
    log(`문제 #${problemId} 완료 (${Math.round((Date.now() - started) / 1000)}초)`);
  } catch (e) {
    patch = { status: 'error', error: e.message.slice(0, 500) };
    log(`문제 만들기 실패: ${e.message}`);
  }
  await db(`oj_problem_jobs?id=eq.${job.id}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } });
  return true;
}

// 다시 연결(link)해서 세션 파일이 새로 써질 때까지 기다린다.
async function waitForRelink() {
  const before = existsSync(SESSION_FILE) ? statSync(SESSION_FILE).mtimeMs : 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    if (existsSync(SESSION_FILE) && statSync(SESSION_FILE).mtimeMs !== before) {
      session = null;
      log('다시 연결됐어요.');
      return;
    }
  }
}

async function run() {
  checkClaude();
  await token();
  log(`${session.user.email} 계정으로 워커를 켰어요. 끄려면 Ctrl+C.`);
  await heartbeat();

  // 워커가 없을 때 쌓인 "Claude 분석 필요"와, 이전에 워커가 멈춰서 남은 작업을 대기열로 되돌린다.
  const now = new Date().toISOString();
  const revived = await db('analyses?engine=eq.claude&status=eq.needs_claude', {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'queued', updated_at: now },
  });
  const stale = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  await db(`analyses?engine=eq.claude&status=eq.running&updated_at=lt.${q(stale)}`, {
    method: 'PATCH', body: { status: 'queued', updated_at: now },
  });
  if (revived.length) log(`Claude 분석 필요였던 ${revived.length}개를 처리할게요.`);
  await db(`oj_problem_jobs?status=eq.running&updated_at=lt.${q(stale)}`, {
    method: 'PATCH', body: { status: 'queued', updated_at: now },
  });
  await db(`hints?status=eq.running&updated_at=lt.${q(stale)}`, { method: 'PATCH', body: { status: 'queued', updated_at: now } });
  await db(`solutions?explain_status=eq.running&updated_at=lt.${q(stale)}`, { method: 'PATCH', body: { explain_status: 'queued', updated_at: now } });

  setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_MS); // 실패는 작업 루프가 로그로 남긴다
  let lastError = '';
  for (;;) {
    let worked = false;
    try {
      worked = (await processHint()) || (await processSolutionExplain())
        || (await processNext()) || (await processProblemJob());
      lastError = '';
    } catch (e) {
      if (e.message !== lastError) log('오류:', e.message); // 같은 오류는 한 번만 남긴다
      lastError = e.message;
      if (e.authLost) {
        await waitForRelink();
        continue;
      }
    }
    if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const commands = { link, login, logout, run };
if (!commands[command]) {
  console.error('사용법: node worker.js [link <코드>|login|logout] [--model sonnet]');
  process.exit(1);
}
commands[command]().catch((e) => { console.error(e.message); process.exit(1); });
