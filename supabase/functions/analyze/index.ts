// 대시보드의 "분석" 버튼 요청을 받는다.
//   { kind: 'problem', judge, problem_id }  문제별 분석
//   { kind: 'overall' }                      종합 리포트
// 쉬운 문제는 여기서 바로 Gemma(무료)로 분석하고, 어려운 문제는 Claude 워커 대기열에 넣거나
// 워커가 없으면 "Claude 분석 필요"로 표시한다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  SYSTEM_PROMPT, PROBLEM_SCHEMA, OVERALL_SCHEMA, problemPrompt, overallPrompt,
  toInput, route, normalizeProblemOutput, normalizeOverallOutput, buildOverallInputs,
} from '../_shared/analysis.js';
import { callOpenRouter } from '../_shared/openrouter.js';

const GEMMA_MODEL = 'google/gemma-4-31b-it:free';
const GEMMA_DAILY_LIMIT = 15; // 한 사람당 하루 Gemma 분석 횟수 (무료 키를 모두가 나눠 쓴다)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST만 지원합니다' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  // 사용자 토큰으로 접속해서 RLS가 그대로 적용되게 한다.
  const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user } } = await sb.auth.getUser(authHeader.replace(/^Bearer /, ''));
  if (!user) return reply({ error: '로그인이 필요합니다' }, 401);

  try {
    const body = await req.json();
    if (body.kind === 'problem') return reply(await analyzeProblem(sb, user, body));
    if (body.kind === 'overall') return reply(await analyzeOverall(sb, user));
    return reply({ error: 'kind는 problem 또는 overall이어야 합니다' }, 400);
  } catch (e) {
    if (e instanceof UserError) return reply({ error: e.message }, e.status);
    console.error(e);
    return reply({ error: '서버 오류가 났어요. 잠시 후 다시 시도해 주세요.' }, 500);
  }
});

async function hasClaudeWorker(sb) {
  const { data } = await sb.from('claude_workers').select('owner_id').maybeSingle();
  return !!data;
}

async function checkGemmaQuota(sb) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await sb.from('analyses').select('id', { count: 'exact', head: true })
    .eq('engine', 'gemma').gte('created_at', since);
  if ((count ?? 0) >= GEMMA_DAILY_LIMIT) {
    throw new UserError(`오늘 Gemma 분석 한도(${GEMMA_DAILY_LIMIT}회)를 다 썼어요. 내일 다시 시도하거나 Claude를 연결하세요.`, 429);
  }
}

async function insertAnalysis(sb, row) {
  const { data, error } = await sb.from('analyses').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Gemma 분석은 오래 걸려서(수십 초) 응답은 먼저 보내고 백그라운드에서 끝낸다.
function runGemmaInBackground(sb, row, { prompt, schema, normalize }) {
  const work = (async () => {
    let patch;
    try {
      const { output } = await callOpenRouter({
        apiKey: Deno.env.get('OPENROUTER_API_KEY'), model: GEMMA_MODEL,
        system: SYSTEM_PROMPT, prompt, schema,
        retries: 2, backoffMs: 10000, timeoutMs: 100000, // Edge Function 실행 시간 제한(150초) 안에 끝낸다
      });
      patch = { status: 'done', result: normalize(output), error: null };
    } catch (e) {
      patch = { status: 'error', error: e.message.slice(0, 500) };
    }
    await sb.from('analyses').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', row.id);
  })();
  EdgeRuntime.waitUntil(work);
}

async function analyzeProblem(sb, user, { judge = 'dshs', problem_id }) {
  if (!problem_id) throw new UserError('problem_id가 필요합니다');
  const problemId = String(problem_id);
  const { data: subs, error } = await sb.from('submissions')
    .select('submission_id,problem_title,verdict,submitted_at,max_time_ms,max_memory_kb,testcase_results,compile_output,source_code')
    .eq('judge', judge).eq('problem_id', problemId).order('submitted_at');
  if (error) throw error;
  if (!subs.length) throw new UserError('이 문제의 제출 기록이 없어요', 404);
  const { data: problem } = await sb.from('problems').select('*')
    .eq('judge', judge).eq('problem_id', problemId).maybeSingle();

  const input = toInput(problem, subs, { problemId });
  const { engine, reason } = route(input);
  const base = {
    owner_id: user.id, judge, problem_id: problemId, kind: 'problem', route_reason: reason,
    submission_ids: subs.map((s) => s.submission_id),
  };
  if (!engine) return insertAnalysis(sb, { ...base, engine: 'none', status: 'skipped' });

  if (engine === 'claude') {
    const queued = await hasClaudeWorker(sb);
    return insertAnalysis(sb, { ...base, engine: 'claude', status: queued ? 'queued' : 'needs_claude' });
  }

  await checkGemmaQuota(sb);
  const row = await insertAnalysis(sb, { ...base, engine: 'gemma', model: GEMMA_MODEL, status: 'running' });
  runGemmaInBackground(sb, row, {
    prompt: problemPrompt(input), schema: PROBLEM_SCHEMA,
    normalize: (o) => normalizeProblemOutput(o, input),
  });
  return row;
}

async function analyzeOverall(sb, user) {
  const [{ data: subs, error: e1 }, { data: analyses, error: e2 }] = await Promise.all([
    sb.from('submissions').select('judge,submission_id,problem_id,problem_title,verdict,submitted_at'),
    sb.from('analyses').select('judge,problem_id,kind,status,result,created_at').eq('kind', 'problem'),
  ]);
  if (e1 || e2) throw e1 || e2;
  const { done, pending } = buildOverallInputs(subs, analyses);
  if (!done.length) throw new UserError('먼저 문제별 분석이 하나 이상 끝나야 종합 리포트를 만들 수 있어요');

  const base = { owner_id: user.id, kind: 'overall', submission_ids: subs.map((s) => s.submission_id) };
  if (await hasClaudeWorker(sb)) {
    return insertAnalysis(sb, { ...base, engine: 'claude', status: 'queued', route_reason: 'claude_connected' });
  }
  await checkGemmaQuota(sb);
  const row = await insertAnalysis(sb, { ...base, engine: 'gemma', model: GEMMA_MODEL, status: 'running', route_reason: 'gemma_default' });
  runGemmaInBackground(sb, row, {
    prompt: overallPrompt(done, pending), schema: OVERALL_SCHEMA,
    normalize: normalizeOverallOutput,
  });
  return row;
}
