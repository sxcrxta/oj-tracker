// 연습장 페이지 공통: Supabase 클라이언트, 로그인 확인, 머리글, 작은 도구들.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// 1MB 미만은 KB로 보여준다.
export const fmtMem = (kb) => (kb >= 1024 ? `${Math.round(kb / 1024)}MB` : `${kb}KB`);
export const fmtTime = (t) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

export const VERDICTS = {
  Accepted: '맞았습니다', WrongAnswer: '틀렸습니다', TimeLimitExceeded: '시간 초과',
  MemoryLimitExceeded: '메모리 초과', RuntimeError: '런타임 에러', CompilationError: '컴파일 에러',
  JudgeError: '채점 오류',
};
export const verdictName = (v) => VERDICTS[v] ?? v ?? '-';
export const verdictClass = (v) => (VERDICTS[v] ? `v v-${v}` : 'v v-other');

// 로그인하지 않았으면 대시보드 로그인 화면으로 보냈다가 돌아오게 한다.
export async function requireUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {});
  }
  const { data: isAdmin } = await sb.rpc('is_oj_admin');
  renderHeader(session.user, !!isAdmin);
  return { user: session.user, isAdmin: !!isAdmin };
}

function renderHeader(user, isAdmin) {
  const page = location.pathname.includes('admin') ? 'admin' : 'problems';
  $('top').innerHTML = `
    <nav class="nav">
      <a href="/oj/" class="brand">연습장</a>
      <a href="/oj/" class="${page === 'problems' ? 'on' : ''}">문제</a>
      ${isAdmin ? `<a href="/oj/admin.html" class="${page === 'admin' ? 'on' : ''}">관리</a>` : ''}
      <a href="/library.html">코드 정리</a>
      <a href="/graph.html">연결 지도</a>
      <a href="/">대시보드</a>
    </nav>
    <span class="muted small who">${esc(user.email)}</span>`;
}

// 문제 설명: 마크다운 + 수식($...$). 관리자만 쓰지만 한 번 걸러서 넣는다.
export function renderMarkdown(el, text) {
  el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text || ''));
  window.renderMathInElement?.(el, {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
    throwOnError: false,
  });
}
