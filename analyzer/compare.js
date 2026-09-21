// 같은 제출 데이터를 여러 모델로 분석해서 결과를 나란히 저장한다.
//   node compare.js <dataset.json> <모델...>
//   모델 예: claude:sonnet  openrouter:google/gemma-4-31b-it  google:gemini-2.5-flash
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { claudeCli, googleAi, openRouter } from './providers.js';
import {
  SYSTEM_PROMPT, PROBLEM_SCHEMA, OVERALL_SCHEMA, MISTAKE_TAGS, problemPrompt, overallPrompt,
} from './prompts.js';

const env = Object.fromEntries(
  (existsSync(new URL('../.env', import.meta.url)) ? readFileSync(new URL('../.env', import.meta.url), 'utf8') : '')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const [datasetPath, ...modelSpecs] = process.argv.slice(2);
if (!datasetPath || !modelSpecs.length) {
  console.error('사용법: node compare.js <dataset.json> claude:sonnet google:gemma-3-27b-it ...');
  process.exit(1);
}
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

const providers = modelSpecs.map((spec) => {
  const [kind, model] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
  if (kind === 'claude') return claudeCli({ model });
  if (kind === 'google') {
    const apiKey = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('.env에 GEMINI_API_KEY가 없습니다');
    return googleAi({ model, apiKey });
  }
  if (kind === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('.env에 OPENROUTER_API_KEY가 없습니다');
    return openRouter({ model, apiKey });
  }
  throw new Error(`알 수 없는 모델: ${spec}`);
});

// 출력이 형식을 지켰는지 간단히 검사한다. (Gemma는 JSON 모드가 없어서 어길 수 있다)
function checkProblemOutput(o, p) {
  const issues = [];
  for (const k of PROBLEM_SCHEMA.required) if (!(k in o)) issues.push(`${k} 누락`);
  const tagOk = (t) => t in MISTAKE_TAGS;
  for (const a of o.attempts || []) {
    if (!tagOk(a.tag)) issues.push(`잘못된 태그 ${a.tag}`);
    if (a.n < 1 || a.n > p.submissions.length) issues.push(`없는 제출 번호 ${a.n}`);
  }
  for (const w of o.weak_points || []) if (!tagOk(w.tag)) issues.push(`잘못된 태그 ${w.tag}`);
  return issues;
}

const results = { createdAt: new Date().toISOString(), models: providers.map((p) => p.name), problems: [], overall: {} };

async function runProvider(provider) {
  const perProblem = [];
  for (const p of dataset) {
    process.stdout.write(`[${provider.name}] #${p.problemId} ... `);
    try {
      const { output, meta } = await provider.analyze({ system: SYSTEM_PROMPT, prompt: problemPrompt(p), schema: PROBLEM_SCHEMA });
      const issues = checkProblemOutput(output, p);
      perProblem.push({ problemId: p.problemId, output, meta, issues });
      console.log(`${meta.ms}ms${issues.length ? ` (형식 문제 ${issues.length})` : ''}`);
    } catch (e) {
      perProblem.push({ problemId: p.problemId, error: e.message });
      console.log(`실패: ${e.message.slice(0, 200)}`);
    }
  }
  const ok = perProblem.filter((r) => r.output && r.output.summary);
  let overall;
  try {
    const input = ok.map((r) => ({ problem: dataset.find((p) => p.problemId === r.problemId), result: {
      summary: r.output.summary, weak_points: r.output.weak_points || [], attempts: r.output.attempts || [] } }));
    overall = await provider.analyze({ system: SYSTEM_PROMPT, prompt: overallPrompt(input), schema: OVERALL_SCHEMA });
    console.log(`[${provider.name}] 종합 리포트 완료`);
  } catch (e) {
    overall = { error: e.message };
    console.log(`[${provider.name}] 종합 리포트 실패: ${e.message.slice(0, 200)}`);
  }
  return { perProblem, overall };
}

// 공급자끼리는 동시에 돌린다.
const runs = await Promise.all(providers.map(runProvider));
for (const p of dataset) {
  results.problems.push({
    ...p,
    analyses: Object.fromEntries(providers.map((pr, i) => [pr.name, runs[i].perProblem.find((r) => r.problemId === p.problemId)])),
  });
}
providers.forEach((pr, i) => { results.overall[pr.name] = runs[i].overall; });

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const outPath = new URL(`./results/compare-${Date.now()}.json`, import.meta.url);
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`저장: ${outPath.pathname}`);
