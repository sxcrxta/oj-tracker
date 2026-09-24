// 문제 연결 지도: 문제를 점으로, 연결을 선으로 그린다. 점을 누르면 그 문제로 갈 수 있다.
import {
  $, esc, requireUser, loadProblems, linksOf, LINK_KINDS, problemUrl, problemKey, shortLabel, JUDGE_LABEL,
} from './shared.js';

await requireUser();
const { problems, links } = await loadProblems();

const canvas = $('graph');
const ctx = canvas.getContext('2d');
const css = getComputedStyle(document.documentElement);
const color = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);

let nodes = [];
let edges = [];
let selected = null;
let view = { x: 0, y: 0, scale: 1 };
let dragging = null;     // 끌고 있는 점
let panning = null;
let alpha = 1;           // 배치가 얼마나 더 움직일지 (0이면 멈춤)

// ---------- 자료 준비 ----------
function build() {
  const onlyLinked = $('only-linked').checked;
  const linked = new Set();
  for (const l of links) {
    linked.add(problemKey(l.from_judge, l.from_problem));
    linked.add(problemKey(l.to_judge, l.to_problem));
  }
  const shown = problems.filter((p) => !onlyLinked || linked.has(p.key));
  const byKey = new Map();
  const prev = new Map(nodes.map((n) => [n.key, n]));
  nodes = shown.map((p, i) => {
    const angle = (i / Math.max(1, shown.length)) * Math.PI * 2;
    const old = prev.get(p.key);
    const n = old ?? { x: Math.cos(angle) * 180, y: Math.sin(angle) * 180, vx: 0, vy: 0 };
    return Object.assign(n, { key: p.key, judge: p.judge, id: p.id, title: p.title, solved: p.solved, tried: p.tried, solutions: p.solutions });
  });
  for (const n of nodes) byKey.set(n.key, n);
  edges = links
    .map((l) => ({ a: byKey.get(problemKey(l.from_judge, l.from_problem)), b: byKey.get(problemKey(l.to_judge, l.to_problem)), kind: l.kind }))
    .filter((e) => e.a && e.b);
  alpha = 1;
}

// ---------- 배치 (간단한 힘 계산) ----------
function tick() {
  if (alpha > 0.005) {
    alpha *= 0.98;
    for (const n of nodes) {
      // 가운데로 약하게 당기기
      n.vx -= n.x * 0.0016;
      n.vy -= n.y * 0.0016;
    }
    // 점끼리 밀어내기
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]; const b = nodes[j];
        let dx = b.x - a.x; let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const force = 9000 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force; const fy = (dy / d) * force;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    // 연결된 점은 당기기
    for (const e of edges) {
      const dx = e.b.x - e.a.x; const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const force = (d - 140) * 0.02;
      const fx = (dx / d) * force; const fy = (dy / d) * force;
      e.a.vx += fx; e.a.vy += fy; e.b.vx -= fx; e.b.vy -= fy;
    }
    for (const n of nodes) {
      if (n === dragging) { n.vx = 0; n.vy = 0; continue; }
      n.x += (n.vx *= 0.82) * alpha;
      n.y += (n.vy *= 0.82) * alpha;
    }
  }
  draw();
  requestAnimationFrame(tick);
}

// ---------- 그리기 ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.x = rect.width / 2;
  view.y = rect.height / 2;
}

const nodeRadius = (n) => 7 + Math.min(6, n.solutions * 2);
const toScreen = (n) => ({ x: view.x + n.x * view.scale, y: view.y + n.y * view.scale });

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  for (const e of edges) {
    const a = toScreen(e.a); const b = toScreen(e.b);
    ctx.strokeStyle = e.kind === 'similar' ? color('--muted', '#888') : color('--accent', '#2563eb');
    ctx.globalAlpha = e.kind === 'similar' ? 0.5 : 0.8;
    ctx.lineWidth = e.kind === 'similar' ? 1.2 : 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (e.kind !== 'similar') { // 확장 방향으로 화살표
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const r = nodeRadius(e.b) * view.scale + 3;
      const tipX = b.x - Math.cos(ang) * r; const tipY = b.y - Math.sin(ang) * r;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(ang - 0.4) * 9, tipY - Math.sin(ang - 0.4) * 9);
      ctx.lineTo(tipX - Math.cos(ang + 0.4) * 9, tipY - Math.sin(ang + 0.4) * 9);
      ctx.closePath();
      ctx.fillStyle = color('--accent', '#2563eb');
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  ctx.font = `${12 * Math.min(1.2, view.scale)}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif`;
  ctx.textAlign = 'center';
  for (const n of nodes) {
    const p = toScreen(n);
    const r = nodeRadius(n) * view.scale;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.solved ? color('--ac', '#16a34a') : n.tried ? color('--wa', '#dc2626') : color('--muted', '#888');
    ctx.fill();
    if (n === selected) {
      ctx.strokeStyle = color('--fg', '#fff');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = color('--fg', '#111');
    const label = `${shortLabel(n.judge, n.id)} ${n.title}`;
    ctx.fillText(label.length > 22 ? `${label.slice(0, 21)}…` : label, p.x, p.y + r + 14);
  }
}

// ---------- 조작 ----------
const pointerPos = (e) => {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};
const nodeAt = (pos) => nodes.find((n) => {
  const p = toScreen(n);
  return Math.hypot(p.x - pos.x, p.y - pos.y) <= nodeRadius(n) * view.scale + 4;
});

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const pos = pointerPos(e);
  const hit = nodeAt(pos);
  if (hit) {
    dragging = hit;
    select(hit);
  } else {
    panning = { ...pos, vx: view.x, vy: view.y };
  }
});
canvas.addEventListener('pointermove', (e) => {
  const pos = pointerPos(e);
  if (dragging) {
    dragging.x = (pos.x - view.x) / view.scale;
    dragging.y = (pos.y - view.y) / view.scale;
    alpha = Math.max(alpha, 0.3);
  } else if (panning) {
    view.x = panning.vx + (pos.x - panning.x);
    view.y = panning.vy + (pos.y - panning.y);
  } else {
    canvas.style.cursor = nodeAt(pos) ? 'pointer' : 'grab';
  }
});
const endDrag = () => { dragging = null; panning = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const pos = pointerPos(e);
  const factor = Math.exp(-e.deltaY * 0.001);
  const next = Math.min(2.5, Math.max(0.35, view.scale * factor));
  // 커서 위치를 기준으로 확대/축소
  view.x = pos.x - ((pos.x - view.x) * next) / view.scale;
  view.y = pos.y - ((pos.y - view.y) * next) / view.scale;
  view.scale = next;
}, { passive: false });

function select(n) {
  selected = n;
  const mine = linksOf(links, n.judge, n.id);
  $('side').hidden = false;
  $('side').innerHTML = `
    <div class="card-head" style="margin:0"><h2>${esc(shortLabel(n.judge, n.id))} ${esc(n.title)}</h2>
      <button class="ghost small" id="side-close" aria-label="닫기">✕</button></div>
    <div class="muted small">${esc(JUDGE_LABEL[n.judge] ?? n.judge)} · ${n.solved ? '해결' : n.tried ? '미해결' : '안 풀어봄'}${n.solutions ? ` · 정리한 풀이 ${n.solutions}개` : ''}</div>
    ${mine.length ? `<div class="links">${mine.map((l) => `<div class="link-row"><span class="pill">${esc(LINK_KINDS[l.kind])}</span>
      <a href="#" data-goto="${esc(problemKey(l.judge, l.id))}">${esc(shortLabel(l.judge, l.id))} ${esc(l.title ?? '')}</a></div>`).join('')}</div>`
    : '<p class="muted small">연결된 문제가 없어요.</p>'}
    <div class="row-inline">
      <a href="${esc(problemUrl(n.judge, n.id))}" target="_blank" rel="noopener">문제 열기</a>
      <a href="/library.html?judge=${encodeURIComponent(n.judge)}&problem=${encodeURIComponent(n.id)}">코드 정리</a>
    </div>`;
  $('side-close').onclick = () => { selected = null; $('side').hidden = true; };
  $('side').querySelectorAll('[data-goto]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const target = nodes.find((x) => x.key === a.dataset.goto);
      if (target) { select(target); view.x -= target.x * view.scale; view.y -= target.y * view.scale; }
      else location.href = `/library.html?judge=${a.dataset.goto.split(':')[0]}&problem=${a.dataset.goto.split(':')[1]}`;
    };
  });
}

$('only-linked').addEventListener('change', () => { build(); selected = null; $('side').hidden = true; });
window.addEventListener('resize', resize);

// ---------- 시작 ----------
resize();
build();
if (!nodes.length && $('only-linked').checked) {
  // 아직 연결이 하나도 없으면 전체를 보여준다.
  $('only-linked').checked = false;
  build();
}
const focus = new URLSearchParams(location.search).get('focus');
const focusNode = focus && nodes.find((n) => n.key === focus);
if (focusNode) select(focusNode);
tick();

