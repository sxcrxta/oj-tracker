// 분석 모델 공급자. 모두 analyze({ system, prompt, schema }) → 객체 를 제공한다.
import { spawn } from 'node:child_process';
import { parseJson } from './prompts.js';
import { callOpenRouter } from '../supabase/functions/_shared/openrouter.js';

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
  return {
    name: `openrouter:${model}`,
    analyze: ({ system, prompt, schema }) => callOpenRouter({ apiKey, model, system, prompt, schema }),
  };
}
