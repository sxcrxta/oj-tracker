// Claude 워커를 비밀번호 없이 연결하기 위한 일회용 코드.
//   { action: 'create' }        (대시보드, 로그인 필요) → { code, expires_at }
//   { action: 'redeem', code }  (워커, 로그인 불필요)   → { token_hash, email }
// 워커는 받은 token_hash로 /auth/v1/verify를 호출해 자기 세션을 만든다.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CODE_TTL_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const s = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

const normalize = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST만 지원합니다' }, 405);
  try {
    const body = await req.json();

    if (body.action === 'create') {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
      const { data: { user } } = await admin.auth.getUser(jwt);
      if (!user) return reply({ error: '로그인이 필요합니다' }, 401);
      // 이 사용자의 이전 코드는 지운다.
      await admin.from('worker_links').delete().eq('owner_id', user.id);
      const code = newCode();
      const expires_at = new Date(Date.now() + CODE_TTL_MS).toISOString();
      const { error } = await admin.from('worker_links').insert({ code_hash: await sha256(normalize(code)), owner_id: user.id, expires_at });
      if (error) throw error;
      return reply({ code, expires_at });
    }

    if (body.action === 'redeem') {
      const hash = await sha256(normalize(body.code));
      // 한 번 쓰면 바로 지운다.
      const { data: rows, error } = await admin.from('worker_links').delete().eq('code_hash', hash).select();
      if (error) throw error;
      const link = rows?.[0];
      if (!link || Date.parse(link.expires_at) < Date.now()) {
        return reply({ error: '코드가 틀렸거나 만료됐어요. 대시보드에서 새 코드를 받으세요.' }, 400);
      }
      const { data: { user }, error: e2 } = await admin.auth.admin.getUserById(link.owner_id);
      if (e2 || !user?.email) throw e2 ?? new Error('사용자를 찾을 수 없음');
      const { data, error: e3 } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
      if (e3) throw e3;
      return reply({ token_hash: data.properties.hashed_token, email: user.email });
    }

    return reply({ error: 'action은 create 또는 redeem이어야 합니다' }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: '서버 오류가 났어요. 잠시 후 다시 시도해 주세요.' }, 500);
  }
});
