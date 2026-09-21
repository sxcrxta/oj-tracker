// 로그인 세션을 관리하고, content script가 보낸 제출 기록을 Supabase에 저장한다.
// 저장 실패한 기록은 outbox에 쌓아두고 1분마다 다시 시도한다.
import { SUPABASE_URL, SUPABASE_KEY, DASHBOARD_URL } from './config.js';

const baseHeaders = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };

async function authRequest(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST', headers: baseHeaders, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `인증 실패 (${res.status})`);
  return data;
}

const toSession = (d) => ({
  access_token: d.access_token,
  refresh_token: d.refresh_token,
  expires_at: d.expires_at ? d.expires_at * 1000 : Date.now() + d.expires_in * 1000,
  user: { id: d.user.id, email: d.user.email },
});

async function startSession(data) {
  const session = toSession(data);
  // 로그인한 시점 이후의 제출만 저장한다. (계정이 바뀌면 기록 상태를 초기화)
  const { session: prev, trackingSince } = await chrome.storage.local.get(['session', 'trackingSince']);
  const sameUser = prev?.user?.id === session.user.id;
  await chrome.storage.local.set({
    session,
    trackingSince: sameUser && trackingSince ? trackingSince : Date.now(),
    ...(sameUser ? {} : { synced: {}, outbox: [], savedCount: 0, lastSaved: null }),
  });
  return session;
}

let refreshing = null;
async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return null;
  if (session.expires_at - Date.now() > 60_000) return session;
  refreshing ||= authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
    .then(async (d) => {
      const next = toSession(d);
      await chrome.storage.local.set({ session: next });
      return next;
    })
    .catch(async (e) => {
      // refresh token이 무효하면 다시 로그인해야 한다
      if (/invalid|not found|expired/i.test(e.message)) await chrome.storage.local.remove('session');
      throw e;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function upsert(record, session) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/submissions?on_conflict=owner_id,judge,submission_id`,
    {
      method: 'POST',
      headers: {
        ...baseHeaders,
        Authorization: `Bearer ${session.access_token}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ ...record, owner_id: session.user.id }),
    },
  );
  if (!res.ok) throw new Error(`저장 실패 (${res.status}) ${await res.text()}`);
}

// 저장 결과를 로컬 상태에 반영한다. 여러 탭에서 동시에 호출돼도 순서대로 처리한다.
let stateLock = Promise.resolve();
function updateState(fn) {
  stateLock = stateLock.then(async () => {
    const s = await chrome.storage.local.get(['synced', 'outbox', 'savedCount']);
    await chrome.storage.local.set(fn({ synced: s.synced || {}, outbox: s.outbox || [], savedCount: s.savedCount || 0 }));
  });
  return stateLock;
}

const keyOf = (r) => `${r.judge}:${r.submission_id}`;

async function save(record) {
  const session = await getSession().catch(() => null);
  if (!session) throw new Error('로그인이 필요합니다');
  try {
    await upsert(record, session);
  } catch (e) {
    await updateState((s) => ({
      outbox: [...s.outbox.filter((r) => keyOf(r) !== keyOf(record)), record],
      synced: { ...s.synced, [keyOf(record)]: 'queued' },
    }));
    chrome.alarms.create('flush', { periodInMinutes: 1 });
    throw e;
  }
  await updateState((s) => ({
    synced: { ...s.synced, [keyOf(record)]: Date.now() },
    outbox: s.outbox.filter((r) => keyOf(r) !== keyOf(record)),
    savedCount: s.savedCount + (typeof s.synced[keyOf(record)] === 'number' ? 0 : 1),
    lastSaved: {
      problem: `#${record.problem_id} ${record.problem_title ?? ''}`.trim(),
      verdict: record.verdict,
      at: Date.now(),
    },
  }));
  flashBadge();
}

async function flushOutbox() {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  for (const record of outbox) {
    try { await save(record); } catch { return; }
  }
  const { outbox: left = [] } = await chrome.storage.local.get('outbox');
  if (left.length === 0) chrome.alarms.clear('flush');
}

function flashBadge() {
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  chrome.action.setBadgeText({ text: '✓' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'flush') flushOutbox(); });

const handlers = {
  save: ({ record }) => save(record),
  signIn: async ({ email, password }) => {
    const d = await authRequest('token?grant_type=password', { email, password });
    const s = await startSession(d);
    return { email: s.user.email };
  },
  signUp: async ({ email, password }) => {
    const d = await authRequest('signup', { email, password });
    if (!d.access_token) return { needsConfirm: true };
    const s = await startSession(d);
    return { email: s.user.email };
  },
  signOut: async () => {
    const { session } = await chrome.storage.local.get('session');
    if (session) {
      fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST', headers: { ...baseHeaders, Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {});
    }
    await chrome.storage.local.remove('session');
  },
  status: async () => {
    const s = await chrome.storage.local.get(['session', 'trackingSince', 'savedCount', 'lastSaved', 'outbox']);
    return {
      email: s.session?.user?.email ?? null,
      trackingSince: s.trackingSince ?? null,
      savedCount: s.savedCount ?? 0,
      lastSaved: s.lastSaved ?? null,
      queued: (s.outbox || []).length,
      dashboardUrl: DASHBOARD_URL,
    };
  },
  flush: () => flushOutbox(),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return;
  Promise.resolve(handler(msg))
    .then((data) => reply({ ok: true, ...(data || {}) }))
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});
