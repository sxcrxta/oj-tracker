// 분석 모델 공급자. 모두 analyze({ system, prompt, schema }) → 객체 를 제공한다.
import { spawn } from 'node:child_process';

// Claude Code CLI (claude -p). 사용자의 Claude 구독으로 동작한다.
export function claudeCli({ model = 'sonnet' } = {}) {
  return {
    name: `claude-cli:${model}`,
    analyze: ({ system, prompt, schema }) => new Promise((resolve, reject) => {
      const args = [
        '-p', '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
        '--system-prompt', system,
        '--tools', '',
        '--no-session-persistence',
        '--model', model,
      ];
      const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        try {
          const res = JSON.parse(out);
          if (res.is_error || !res.structured_output) throw new Error(res.result || 'structured_output 없음');
          resolve({ output: res.structured_output, meta: { costUsd: res.total_cost_usd, ms: res.duration_ms } });
        } catch (e) {
          reject(new Error(`claude 실패 (exit ${code}): ${e.message} ${err.slice(0, 500)}`));
        }
      });
      child.stdin.end(prompt);
    }),
  };
}

// Google AI Studio의 Gemma / Gemini 모델 (generateContent REST API).
export function googleAi({ model, apiKey }) {
  const isGemma = model.startsWith('gemma');
  return {
    name: `google:${model}`,
    async analyze({ system, prompt, schema }) {
      // Gemma는 system instruction과 JSON 모드를 지원하지 않을 수 있어서 프롬프트에 직접 넣는다.
      const text = isGemma
        ? `${system}\n\n${prompt}\n\n다음 JSON Schema를 따르는 JSON 객체 하나만 출력하라. 코드 블록이나 다른 설명은 쓰지 마라.\n${JSON.stringify(schema)}`
        : prompt;
      const body = {
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: 0.2 },
      };
      if (!isGemma) {
        body.systemInstruction = { parts: [{ text: system }] };
        body.generationConfig.responseMimeType = 'application/json';
        body.generationConfig.responseJsonSchema = schema;
      }
      const started = Date.now();
      let retries = 0;
      // 무료 등급은 과부하(503)·서버 오류(500)·호출 제한(429)이 잦아서 기다렸다가 다시 시도한다.
      for (let attempt = 0; ; attempt++) {
        let wait = 0;
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) },
          );
          const data = await res.json();
          if (!res.ok) {
            const err = new Error(`${model} 실패 (${res.status}): ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
            if (![429, 500, 503].includes(res.status)) throw Object.assign(err, { fatal: true });
            const hint = data.error?.details?.find((d) => d.retryDelay)?.retryDelay;
            wait = hint ? parseFloat(hint) * 1000 + 1000 : 0;
            throw err;
          }
          // 생각 과정(thought) 파트는 빼고 답만 모은다.
          const raw = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
          return { output: parseJson(raw), meta: { ms: Date.now() - started, tokens: data.usageMetadata, retries } };
        } catch (e) {
          if (e.fatal || attempt >= 4) throw new Error(`${e.message} (재시도 ${retries}회 후)`);
          retries++;
          await new Promise((r) => setTimeout(r, wait || 15000 * 2 ** attempt));
        }
      }
    },
  };
}

// OpenRouter (OpenAI 호환 API). 여러 회사 모델을 키 하나로 쓴다.
export function openRouter({ model, apiKey }) {
  // 무료(:free) 모델은 JSON 형식 강제를 지원하지 않아서 형식을 프롬프트에 직접 적고,
  // 결과가 깨지면 아래 재시도 루프에서 다시 요청한다.
  const free = model.endsWith(':free');
  return {
    name: `openrouter:${model}`,
    async analyze({ system, prompt, schema }) {
      const body = free
        ? {
          model,
          messages: [{ role: 'user', content: `${system}\n\n${prompt}\n\n다음 JSON Schema를 따르는 JSON 객체 하나만 출력하라. 코드 블록이나 다른 설명은 쓰지 마라.\n${JSON.stringify(schema)}` }],
          temperature: 0.2,
        }
        : {
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          temperature: 0.2,
          response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema } },
          provider: { require_parameters: true }, // JSON 형식을 지원하는 곳으로만 보낸다
        };
      const started = Date.now();
      let retries = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'OJ Analyzer' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            const status = data.error?.code ?? res.status;
            const err = new Error(`${model} 실패 (${status}): ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
            if ([400, 401, 402, 403, 404].includes(res.status)) err.fatal = true;
            throw err;
          }
          const raw = data.choices?.[0]?.message?.content ?? '';
          return { output: parseJson(raw), meta: { ms: Date.now() - started, tokens: data.usage, retries, provider: data.provider } };
        } catch (e) {
          if (e.fatal || attempt >= 3) throw new Error(`${e.message} (재시도 ${retries}회 후)`);
          retries++;
          // 무료 모델은 분당 호출 제한이 있어서 더 오래 기다린다.
          await new Promise((r) => setTimeout(r, (free ? 20000 : 5000) * 2 ** attempt));
        }
      }
    },
  };
}

// 모델이 코드 블록이나 앞뒤 설명을 붙여도 가장 바깥 JSON 객체만 꺼낸다.
function parseJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`JSON을 찾지 못함: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1));
}
