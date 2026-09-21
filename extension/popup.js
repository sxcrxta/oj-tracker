const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

const VERDICT_KO = {
  Accepted: '맞았습니다', WrongAnswer: '틀렸습니다', TimeLimitExceeded: '시간 초과',
  MemoryLimitExceeded: '메모리 초과', RuntimeError: '런타임 에러', CompilationError: '컴파일 에러',
};

function showMsg(text, kind = '') {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = !text;
}

const fmt = (ms) => new Date(ms).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

async function render() {
  const s = await send('status');
  const loggedIn = !!s.email;
  $('auth').hidden = loggedIn;
  $('main').hidden = !loggedIn;
  if (!loggedIn) return;
  $('who').textContent = s.email;
  $('since').textContent = s.trackingSince ? fmt(s.trackingSince) : '-';
  $('count').textContent = `${s.savedCount}개`;
  $('last').textContent = s.lastSaved
    ? `${s.lastSaved.problem} · ${VERDICT_KO[s.lastSaved.verdict] ?? s.lastSaved.verdict}`
    : '아직 없음';
  $('queued').hidden = !s.queued;
  $('queued').textContent = `저장 대기 중 ${s.queued}개 (네트워크 복구 시 자동 재시도)`;
  $('open-dashboard').onclick = () => chrome.tabs.create({ url: s.dashboardUrl });
}

async function auth(type) {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || password.length < 6) return showMsg('이메일과 6자 이상 비밀번호를 입력하세요.', 'err');
  const buttons = document.querySelectorAll('#auth button');
  buttons.forEach((b) => (b.disabled = true));
  const res = await send(type, { email, password });
  buttons.forEach((b) => (b.disabled = false));
  if (!res.ok) return showMsg(res.error, 'err');
  if (res.needsConfirm) return showMsg('가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요.', 'ok');
  showMsg('');
  render();
}

$('auth-form').addEventListener('submit', (e) => { e.preventDefault(); auth('signIn'); });
$('sign-up').addEventListener('click', () => auth('signUp'));
$('sign-out').addEventListener('click', async () => { await send('signOut'); showMsg(''); render(); });

$('sync-now').addEventListener('click', async () => {
  $('sync-now').disabled = true;
  await send('flush');
  await send('inject'); // 스크립트가 없는 탭이 있으면 넣어준다
  const tabs = await chrome.tabs.query({ url: 'https://dshs.app/*' });
  const results = await Promise.all(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'syncNow' }).catch(() => null)),
  );
  $('sync-now').disabled = false;
  if (!tabs.length) showMsg('dshs.app 탭을 열어두면 동기화할 수 있어요.', 'err');
  else showMsg(`새로 저장: ${results.reduce((n, r) => n + (r?.saved || 0), 0)}개`, 'ok');
  render();
});

render();
