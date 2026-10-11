// 대시보드 쪽 페이지들이 함께 쓰는 것들 (코드 정리, 연결 지도).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fmtTime = (t) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

export const JUDGE_LABEL = { dshs: 'dshs.app', self: '연습장' };
export const problemUrl = (judge, id) => (judge === 'self'
  ? `/oj/problem.html?id=${encodeURIComponent(id)}`
  : `https://dshs.app/oj/problem/${encodeURIComponent(id)}`);
export const problemKey = (judge, id) => `${judge}:${id}`;
export const shortLabel = (judge, id) => `${judge === 'self' ? '연습장 ' : ''}#${id}`;

// 분류 색. 지도와 코드 정리가 같은 색을 쓴다. 해결/미해결 색(초록, 빨강)과 헷갈리지 않는 색만 쓴다.
const CATEGORY_COLORS = ['#8b5cf6', '#ec4899', '#0ea5e9', '#f59e0b', '#6366f1', '#14b8a6', '#f97316', '#d946ef'];
export const categoryNames = (problems) => [...new Set(problems.map((p) => p.category).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'ko'));
export const categoryColors = (problems) => new Map(categoryNames(problems)
  .map((name, i) => [name, CATEGORY_COLORS[i % CATEGORY_COLORS.length]]));

export const LINK_KINDS = { extends: '확장 버전', base: '기본 버전', similar: '비슷한 문제' };
// 확장과 기본은 서로 짝이다. 반대 방향에서 볼 때 관계 이름을 뒤집는다.
export const flipKind = (kind) => ({ extends: 'base', base: 'extends', similar: 'similar' }[kind]);

export async function requireUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {});
  }
  const who = $('who');
  if (who) who.textContent = session.user.email;
  return session.user;
}

// 내 기록, 저장한 문제 설명(아직 안 푼 문제 포함), 정리한 풀이, 연결, 연습장 문제, 분류를 모아 문제 목록을 만든다.
// fullSolutions: 코드 본문까지 필요하면 true (코드 정리창). 지도에서는 개수만 세면 된다.
export async function loadProblems({ fullSolutions = false } = {}) {
  const [subs, saved, solutions, links, ojProblems, categories] = await Promise.all([
    sb.from('submissions').select('judge,problem_id,problem_title,verdict,submitted_at').then((r) => r.data ?? []),
    sb.from('problems').select('judge,problem_id,title').then((r) => r.data ?? []),
    sb.from('solutions').select(fullSolutions ? '*' : 'id,judge,problem_id,problem_title,title').then((r) => r.data ?? []),
    sb.from('problem_links').select('*').then((r) => r.data ?? []),
    sb.from('oj_problems').select('id,title').then((r) => r.data ?? []),
    sb.from('problem_categories').select('judge,problem_id,category').then((r) => r.data ?? []),
  ]);

  const map = new Map();
  const touch = (judge, id, title) => {
    const key = problemKey(judge, id);
    if (!map.has(key)) map.set(key, { key, judge, id: String(id), title: title || '', category: null, solved: false, tried: false, solutions: 0, links: 0 });
    const p = map.get(key);
    if (title && !p.title) p.title = title;
    return p;
  };

  for (const p of ojProblems) touch('self', String(p.id), p.title);
  for (const p of saved) touch(p.judge, p.problem_id, p.title);
  for (const s of subs) {
    const p = touch(s.judge, s.problem_id, s.problem_title);
    p.tried = true;
    if (s.verdict === 'Accepted') p.solved = true;
    if (!p.lastAt || s.submitted_at > p.lastAt) p.lastAt = s.submitted_at;
  }
  for (const s of solutions) touch(s.judge, s.problem_id, s.problem_title).solutions += 1;
  for (const l of links) {
    touch(l.from_judge, l.from_problem, l.from_title).links += 1;
    touch(l.to_judge, l.to_problem, l.to_title).links += 1;
  }

  for (const c of categories) {
    const p = map.get(problemKey(c.judge, c.problem_id));
    if (p) p.category = c.category;
  }

  const problems = [...map.values()].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || Number(a.id) - Number(b.id));
  return { problems, solutions, links };
}

// 한 문제에 연결된 것들을 방향을 맞춰서 돌려준다.
export function linksOf(links, judge, id) {
  const out = [];
  for (const l of links) {
    if (l.from_judge === judge && l.from_problem === String(id)) {
      out.push({ row: l, kind: l.kind, judge: l.to_judge, id: l.to_problem, title: l.to_title, note: l.note });
    } else if (l.to_judge === judge && l.to_problem === String(id)) {
      out.push({ row: l, kind: flipKind(l.kind), judge: l.from_judge, id: l.from_problem, title: l.from_title, note: l.note });
    }
  }
  return out;
}
