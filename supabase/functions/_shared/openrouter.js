// OpenRouter 호출 (OpenAI 호환 API). Edge Function과 로컬 도구가 함께 쓴다.
import { parseJson } from './analysis.js';

// 무료(:free) 모델은 JSON 형식 강제를 지원하지 않아서 형식을 프롬프트에 직접 적고,
// 결과가 깨지면 다시 요청한다.
export async function callOpenRouter({
  apiKey, model, system, prompt, schema, retries = 3, backoffMs, timeoutMs = 120000,
}) {
  const free = model.endsWith(':free');
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
  const base = backoffMs ?? (free ? 20000 : 5000); // 무료 모델은 분당 호출 제한이 있어서 더 오래 기다린다
  const started = Date.now();

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'OJ Analyzer' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const err = new Error(`${model} 실패 (${data.error?.code ?? res.status}): ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
        if ([400, 401, 402, 403, 404].includes(res.status)) err.fatal = true;
        throw err;
      }
      const raw = data.choices?.[0]?.message?.content ?? '';
      return { output: parseJson(raw), meta: { ms: Date.now() - started, retries: attempt, usage: data.usage } };
    } catch (e) {
      if (e.fatal || attempt >= retries) throw new Error(`${e.message} (재시도 ${attempt}회 후)`);
      await new Promise((r) => setTimeout(r, base * 2 ** attempt));
    }
  }
}
