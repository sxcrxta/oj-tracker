// 문제 지도: 문제를 점으로, 분류(DP, 정렬 등)를 큰 구슬로 그린다.
// 분류 구슬이 자기 문제들을 끌어당겨 무리를 짓고, 문제끼리의 연결은 흐르는 선으로 보여준다.
import {
  $, esc, sb, requireUser, loadProblems, linksOf, LINK_KINDS, problemUrl, problemKey, shortLabel, JUDGE_LABEL, categoryColors,
} from './shared.js';

await requireUser();
let { problems, links } = await loadProblems();

const canvas = $('graph');
const ctx = canvas.getContext('2d');
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let categoryColor = categoryColors(problems);

let nodes = [];
let edges = [];
let selected = null;
let hovered = null;
let focusSet = null;     // 강조할 점들 (마우스를 올린 점과 이웃). 없으면 모두 보통으로
let view = { x: 0, y: 0, scale: 1 };
let dragging = null;     // 끌고 있는 점
let panning = null;
let moved = false;       // 누른 뒤 움직였는지 (움직였으면 클릭으로 보지 않는다)
let downAt = null;       // 누른 자리
let alpha = 1;           // 배치가 얼마나 더 움직일지 (0이면 멈춤)
let autoFit = true;      // 직접 움직이기 전까지는 전체가 화면에 들어오게 맞춘다

// ---------- 자료 준비 ----------
function build() {
  const grouped = $('group-category').checked;
  const showAll = $('show-all').checked;
  const linked = new Set();
  for (const l of links) {
    linked.add(problemKey(l.from_judge, l.from_problem));
    linked.add(problemKey(l.to_judge, l.to_problem));
  }
  let shown = problems.filter((p) => showAll || p.category || linked.has(p.key));
  if (!shown.length) shown = problems; // 아직 분류도 연결도 없으면 전부 보여준다
  const names = grouped ? [...new Set(shown.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko')) : [];

  const prev = new Map(nodes.map((n) => [n.key, n]));
  const hubs = names.map((name, i) => {
    const angle = (i / names.length) * Math.PI * 2 - Math.PI / 2;
    const radius = names.length > 1 ? 320 : 0;
    const n = prev.get(`cat:${name}`) ?? { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, born: performance.now() };
    const members = shown.filter((p) => p.category === name);
    return Object.assign(n, {
      key: `cat:${name}`, isCategory: true, title: name, color: categoryColor.get(name),
      count: members.length, solvedCount: members.filter((p) => p.solved).length, order: i,
    });
  });
  const hubByName = new Map(hubs.map((h) => [h.title, h]));

  const placed = new Map(); // 분류마다 지금까지 둘레에 놓은 문제 수
  const problemNodes = shown.map((p, i) => {
    const hub = grouped ? hubByName.get(p.category) ?? null : null;
    let n = prev.get(p.key);
    if (!n) {
      // 처음에는 자기 분류 구슬 둘레에 고르게 놓아서 매번 같은 모양으로 금방 자리를 잡게 한다.
      // 맨 아래에서 시작하면 이름표가 나란히 겹치지 않는다.
      if (hub) {
        const k = placed.get(hub) ?? 0;
        placed.set(hub, k + 1);
        const angle = (k / hub.count) * Math.PI * 2 + Math.PI / 2;
        n = { x: hub.x + Math.cos(angle) * 90, y: hub.y + Math.sin(angle) * 90, vx: 0, vy: 0, born: performance.now() };
      } else {
        const angle = (i / Math.max(1, shown.length)) * Math.PI * 2;
        n = { x: Math.cos(angle) * 180, y: Math.sin(angle) * 180, vx: 0, vy: 0, born: performance.now() };
      }
    }
    return Object.assign(n, {
      key: p.key, isCategory: false, judge: p.judge, id: p.id, title: p.title, category: p.category,
      color: categoryColor.get(p.category) ?? null, hub, solved: p.solved, tried: p.tried, solutions: p.solutions,
      order: (hub?.order ?? names.length) + 1,
    });
  });

  nodes = [...hubs, ...problemNodes];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  edges = [
    ...problemNodes.filter((n) => n.hub).map((n) => ({ a: n, b: n.hub, kind: 'member' })),
    ...links
      .map((l) => ({ a: byKey.get(problemKey(l.from_judge, l.from_problem)), b: byKey.get(problemKey(l.to_judge, l.to_problem)), kind: l.kind }))
      .filter((e) => e.a && e.b),
  ];
  for (const n of nodes) n.neighbors = new Set([n]);
  for (const e of edges) { e.a.neighbors.add(e.b); e.b.neighbors.add(e.a); }
  if (selected) selected = byKey.get(selected.key) ?? null;
  hovered = null;
  focusSet = null;
  alpha = 1;
  renderStats(shown, hubs);
}

function renderStats(shown, hubs) {
  const solved = shown.filter((p) => p.solved).length;
  $('stats').innerHTML = `<span><b>${shown.length}</b> 문제</span><span><b>${solved}</b> 해결</span>${hubs.length ? `<span><b>${hubs.length}</b> 분류</span>` : ''}`;
}

// ---------- 배치 (간단한 힘 계산) ----------
function step() {
  alpha *= 0.985;
  for (const n of nodes) {
    // 가운데로 약하게 당기기
    n.vx -= n.x * 0.0016;
    n.vy -= n.y * 0.0016;
  }
  // 점끼리 밀어내기. 분류 구슬끼리는 세게 밀어서 무리끼리 떨어지게 한다.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]; const b = nodes[j];
      let dx = b.x - a.x; let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const both = a.isCategory && b.isCategory;
      const sameGroup = (a.hub && (a.hub === b.hub || a.hub === b)) || (b.hub && b.hub === a);
      const force = (both ? 150000 : sameGroup ? 5000 : 14000) / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * force; const fy = (dy / d) * force;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  // 연결된 점은 당기기. 분류에 속한 문제는 분류 구슬 가까이로.
  for (const e of edges) {
    const dx = e.b.x - e.a.x; const dy = e.b.y - e.a.y;
    const d = Math.hypot(dx, dy) || 1;
    const force = e.kind === 'member' ? (d - 90) * 0.1 : (d - 140) * (e.a.hub !== e.b.hub ? 0.004 : 0.02);
    const fx = (dx / d) * force; const fy = (dy / d) * force;
    e.a.vx += fx; e.a.vy += fy; e.b.vx -= fx; e.b.vy -= fy;
  }
  for (const n of nodes) {
    if (n === dragging) { n.vx = 0; n.vy = 0; continue; }
    n.x += (n.vx *= 0.82) * alpha;
    n.y += (n.vy *= 0.82) * alpha;
  }
}

function tick(now) {
  if (alpha > 0.005) {
    step();
    if (autoFit) fitView();
  }
  draw(now);
  requestAnimationFrame(tick);
}

function fitView() {
  if (!nodes.length) return;
  const rect = canvas.getBoundingClientRect();
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
    y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
  }
  // 위쪽 제목·버튼과 아래쪽 범례에 가리지 않게 위아래를 더 비운다.
  const padX = 120; const padTop = 110; const padBottom = 90;
  view.scale = Math.min(1.4, Math.max(0.35, Math.min(
    (rect.width - padX * 2) / Math.max(1, x1 - x0),
    (rect.height - padTop - padBottom) / Math.max(1, y1 - y0),
  )));
  view.x = rect.width / 2 - ((x0 + x1) / 2) * view.scale;
  view.y = padTop + (rect.height - padTop - padBottom) / 2 - ((y0 + y1) / 2) * view.scale;
}

// ---------- 그리기 ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (autoFit) fitView();
}

const nodeRadius = (n) => (n.isCategory ? 22 + Math.min(10, n.count * 1.5) : 6 + Math.min(4, n.solutions * 1.5));
const toScreen = (n) => ({ x: view.x + n.x * view.scale, y: view.y + n.y * view.scale });
const fontPx = (px) => px * Math.min(1.25, Math.max(0.85, view.scale));
const font = (px, weight = 400) => `${weight} ${fontPx(px)}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif`;
const easeOut = (t) => 1 - (1 - t) ** 3;

// "#8b5cf6" → "rgba(139,92,246,a)"
function rgba(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
// 새로 생긴 점은 분류 구슬부터 차례로 커지며 나타난다.
function appear(n, now) {
  if (reducedMotion || !n.born) return 1;
  return easeOut(Math.min(1, Math.max(0, (now - n.born - n.order * 70) / 650)));
}
// 마우스를 올린 점과 그 이웃만 또렷하게, 나머지는 흐리게.
const dimOf = (n) => (!focusSet || focusSet.has(n) ? 1 : 0.18);

function drawBackground(rect) {
  const g = ctx.createRadialGradient(rect.width * 0.5, rect.height * 0.42, 0, rect.width * 0.5, rect.height * 0.5, Math.max(rect.width, rect.height) * 0.75);
  g.addColorStop(0, token('--g-bg1', '#161629'));
  g.addColorStop(1, token('--g-bg2', '#07070c'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, rect.width, rect.height);

  // 화면과 같이 움직이는 점 격자
  const gap = 36 * view.scale;
  if (gap < 12) return;
  ctx.fillStyle = token('--g-dot', 'rgba(255,255,255,.07)');
  const ox = ((view.x % gap) + gap) % gap; const oy = ((view.y % gap) + gap) % gap;
  const size = Math.max(1, 1.3 * Math.min(1, view.scale));
  for (let x = ox; x < rect.width; x += gap) {
    for (let y = oy; y < rect.height; y += gap) ctx.fillRect(x, y, size, size);
  }
}

function drawHalos(now) {
  for (const hub of nodes.filter((n) => n.isCategory)) {
    const members = nodes.filter((n) => n.hub === hub);
    let r = nodeRadius(hub) + 30;
    for (const m of members) r = Math.max(r, Math.hypot(m.x - hub.x, m.y - hub.y) + 38);
    const p = toScreen(hub);
    const R = r * view.scale * appear(hub, now);
    if (R <= 0) continue;
    const dim = dimOf(hub);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
    g.addColorStop(0, rgba(hub.color, 0.20 * dim));
    g.addColorStop(0.6, rgba(hub.color, 0.07 * dim));
    g.addColorStop(1, rgba(hub.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fill();
    // 천천히 도는 점선 테두리
    ctx.save();
    ctx.setLineDash([2, 7]);
    ctx.lineDashOffset = reducedMotion ? 0 : -now * 0.004;
    ctx.strokeStyle = rgba(hub.color, 0.35 * dim);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R * 0.97, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawEdges(now) {
  const accent = token('--accent', '#3b82f6');
  const muted = token('--muted', '#a1a1aa');
  for (const e of edges) {
    const a = toScreen(e.a); const b = toScreen(e.b);
    const show = Math.min(appear(e.a, now), appear(e.b, now));
    if (show <= 0) continue;
    const lit = !focusSet || (focusSet.has(e.a) && focusSet.has(e.b));
    ctx.save();
    ctx.globalAlpha = show * (lit ? 1 : 0.15);
    if (e.kind === 'member') {
      // 문제 → 분류 구슬: 살짝 휜 옅은 선
      const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
      const cx = mx + (b.y - a.y) * 0.12; const cy = my - (b.x - a.x) * 0.12;
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, rgba(e.b.color, focusSet && lit ? 0.6 : 0.12));
      g.addColorStop(1, rgba(e.b.color, focusSet && lit ? 0.9 : 0.4));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
    } else if (e.kind === 'similar') {
      ctx.strokeStyle = muted;
      ctx.globalAlpha *= 0.7;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.setLineDash([1, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else {
      // 확장 ↔ 기본: 기본에서 확장 쪽으로 흐르는 선
      ctx.strokeStyle = accent;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 7]);
      ctx.lineDashOffset = reducedMotion ? 0 : now * 0.03;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const r = nodeRadius(e.b) * view.scale + 5;
      const tipX = b.x - Math.cos(ang) * r; const tipY = b.y - Math.sin(ang) * r;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(ang - 0.45) * 9, tipY - Math.sin(ang - 0.45) * 9);
      ctx.lineTo(tipX - Math.cos(ang + 0.45) * 9, tipY - Math.sin(ang + 0.45) * 9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawHub(n, now) {
  const p = toScreen(n);
  const show = appear(n, now);
  if (show <= 0) return;
  const r = nodeRadius(n) * view.scale * show;
  const dim = dimOf(n);
  ctx.save();
  ctx.globalAlpha = dim * show;

  // 숨 쉬듯 퍼지는 고리
  if (!reducedMotion) {
    const t = ((now / 2600) + n.order * 0.23) % 1;
    ctx.strokeStyle = rgba(n.color, 0.45 * (1 - t));
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 4 + t * 22 * view.scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 빛나는 구슬
  ctx.shadowColor = n.color;
  ctx.shadowBlur = 36;
  const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.45, 0, p.x, p.y, r * 1.1);
  g.addColorStop(0, 'rgba(255,255,255,.38)');
  g.addColorStop(0.55, n.color);
  g.addColorStop(1, n.color);
  ctx.fillStyle = n.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = g;
  ctx.fill();

  // 해결한 비율만큼 둘러 그린 고리
  const ringR = r + 5 * view.scale;
  ctx.lineWidth = Math.max(2, 3 * view.scale);
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(n.color, 0.25);
  ctx.beginPath();
  ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
  ctx.stroke();
  if (n.solvedCount) {
    ctx.strokeStyle = token('--ac', '#4ade80');
    ctx.shadowColor = token('--ac', '#4ade80');
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * n.solvedCount) / n.count);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 4;
  ctx.font = font(13, 700);
  ctx.fillText(n.title, p.x, p.y - fontPx(6));
  ctx.font = font(10.5, 500);
  ctx.globalAlpha = dim * show * 0.85;
  ctx.fillText(`${n.solvedCount}/${n.count}`, p.x, p.y + fontPx(8));
  ctx.restore();
}

function drawProblem(n, now) {
  const p = toScreen(n);
  const show = appear(n, now);
  if (show <= 0) return;
  const r = nodeRadius(n) * view.scale * show;
  const dim = dimOf(n);
  const isHot = n === hovered || n === selected;
  const status = n.solved ? token('--ac', '#4ade80') : n.tried ? token('--wa', '#f87171') : null;
  ctx.save();
  ctx.globalAlpha = dim * show;

  // 분류 색 테두리
  if (n.color) {
    ctx.strokeStyle = rgba(n.color, 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * (isHot ? 1.25 : 1), 0, Math.PI * 2);
  if (status) {
    ctx.shadowColor = status;
    ctx.shadowBlur = isHot ? 22 : 12;
    ctx.fillStyle = status;
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = token('--g-bg2', '#07070c');
    ctx.fill();
    ctx.strokeStyle = token('--g-label', '#d4d4d8');
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (n === selected) {
    ctx.strokeStyle = token('--fg', '#fff');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 이름표: 많이 축소했을 때는 강조된 점만
  if (view.scale >= 0.6 || isHot || (focusSet && focusSet.has(n))) {
    const label = `${shortLabel(n.judge, n.id)} ${n.title}`;
    const text = !isHot && label.length > 20 ? `${label.slice(0, 19)}…` : label;
    ctx.font = font(11.5, isHot ? 600 : 450);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = token('--g-bg2', '#07070c');
    ctx.shadowBlur = 6;
    ctx.fillStyle = isHot ? token('--fg', '#fff') : token('--g-label', '#d4d4d8');
    ctx.fillText(text, p.x, p.y + r + 7);
  }
  ctx.restore();
}

function draw(now) {
  const rect = canvas.getBoundingClientRect();
  drawBackground(rect);
  drawHalos(now);
  drawEdges(now);
  for (const n of nodes) if (n.isCategory) drawHub(n, now);
  for (const n of nodes) if (!n.isCategory && n !== hovered && n !== selected) drawProblem(n, now);
  // 강조된 점은 맨 위에
  for (const n of [selected, hovered]) if (n && !n.isCategory && nodes.includes(n)) drawProblem(n, now);
}

// ---------- 조작 ----------
const pointerPos = (e) => {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};
// 문제 점이 분류 구슬 위에 겹쳐 있으면 문제 점을 먼저 잡는다.
const nodeAt = (pos) => [...nodes].reverse().find((n) => {
  const p = toScreen(n);
  return Math.hypot(p.x - pos.x, p.y - pos.y) <= nodeRadius(n) * view.scale + 6;
});

function setHover(n) {
  if (n === hovered) return;
  hovered = n ?? null;
  focusSet = hovered ? hovered.neighbors : selected ? selected.neighbors : null;
  canvas.style.cursor = hovered ? 'pointer' : 'grab';
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const pos = pointerPos(e);
  const hit = nodeAt(pos);
  moved = false;
  downAt = pos;
  if (hit) dragging = hit;
  else panning = { ...pos, vx: view.x, vy: view.y };
});
canvas.addEventListener('pointermove', (e) => {
  const pos = pointerPos(e);
  if (downAt && Math.hypot(pos.x - downAt.x, pos.y - downAt.y) > 3) moved = true;
  if (dragging) {
    if (!moved) return;
    autoFit = false;
    dragging.x = (pos.x - view.x) / view.scale;
    dragging.y = (pos.y - view.y) / view.scale;
    alpha = Math.max(alpha, 0.3);
  } else if (panning) {
    if (moved) { autoFit = false; canvas.style.cursor = 'grabbing'; }
    view.x = panning.vx + (pos.x - panning.x);
    view.y = panning.vy + (pos.y - panning.y);
  } else {
    setHover(nodeAt(pos));
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!moved) {
    const hit = nodeAt(pointerPos(e));
    if (hit) select(hit);
    else if (panning) closeSide();
  }
  dragging = null;
  panning = null;
  downAt = null;
  canvas.style.cursor = hovered ? 'pointer' : 'grab';
});
canvas.addEventListener('pointercancel', () => { dragging = null; panning = null; });
canvas.addEventListener('pointerleave', () => { if (!dragging && !panning) setHover(null); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  autoFit = false;
  const pos = pointerPos(e);
  const factor = Math.exp(-e.deltaY * 0.0015);
  const next = Math.min(2.5, Math.max(0.3, view.scale * factor));
  // 커서 위치를 기준으로 확대/축소
  view.x = pos.x - ((pos.x - view.x) * next) / view.scale;
  view.y = pos.y - ((pos.y - view.y) * next) / view.scale;
  view.scale = next;
}, { passive: false });

// 화면을 부드럽게 옮긴다
function animateView(target, ms = 450) {
  const from = { ...view };
  const start = performance.now();
  const frame = (now) => {
    const t = reducedMotion ? 1 : easeOut(Math.min(1, (now - start) / ms));
    view.x = from.x + (target.x - from.x) * t;
    view.y = from.y + (target.y - from.y) * t;
    view.scale = from.scale + (target.scale - from.scale) * t;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function focusOn(n) {
  autoFit = false;
  select(n);
  const rect = canvas.getBoundingClientRect();
  const scale = Math.max(view.scale, 1);
  animateView({ scale, x: rect.width / 2 - n.x * scale, y: rect.height / 2 - n.y * scale });
}

$('fit').addEventListener('click', () => {
  const before = { ...view };
  fitView();
  const target = { ...view };
  Object.assign(view, before);
  animateView(target);
  autoFit = alpha > 0.005;
});

// ---------- 옆 창 ----------
function closeSide() {
  selected = null;
  focusSet = hovered ? hovered.neighbors : null;
  $('side').hidden = true;
}

const statusDot = (n) => `<i class="legend-dot${n.solved || n.tried ? '' : ' hollow'}" style="${n.solved ? 'background:var(--ac)' : n.tried ? 'background:var(--wa)' : ''}"></i>`;
const statusText = (n) => (n.solved ? '해결' : n.tried ? '미해결' : '안 풀어봄');

function select(n) {
  selected = n;
  focusSet = n.neighbors;
  $('side').hidden = false;
  if (n.isCategory) renderCategorySide(n);
  else renderProblemSide(n);
  $('side-close').onclick = closeSide;
  $('side').querySelectorAll('[data-goto]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const target = nodes.find((x) => x.key === a.dataset.goto);
      if (target) focusOn(target);
      else location.href = `/library.html?judge=${a.dataset.goto.split(':')[0]}&problem=${a.dataset.goto.split(':')[1]}`;
    };
  });
}

function renderCategorySide(hub) {
  const members = nodes.filter((m) => m.hub === hub)
    .sort((a, b) => Number(a.solved) - Number(b.solved) || a.judge.localeCompare(b.judge) || Number(a.id) - Number(b.id));
  const pct = hub.count ? Math.round((hub.solvedCount / hub.count) * 100) : 0;
  $('side').innerHTML = `
    <div class="side-head">
      <div><div class="kicker">분류</div><h2><i class="legend-dot" style="background:${hub.color};box-shadow:0 0 10px ${hub.color}"></i>${esc(hub.title)}</h2></div>
      <button class="ghost small" id="side-close" aria-label="닫기">✕</button>
    </div>
    <div>
      <div class="muted small" style="margin-bottom:6px">${hub.solvedCount}/${hub.count} 해결 · ${pct}%</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
    </div>
    <div class="members">${members.map((m) => `<a class="member" href="#" data-goto="${esc(m.key)}">${statusDot(m)}
      <span>${esc(shortLabel(m.judge, m.id))} ${esc(m.title)}</span></a>`).join('')}</div>`;
}

function renderProblemSide(n) {
  const mine = linksOf(links, n.judge, n.id);
  $('side').innerHTML = `
    <div class="side-head">
      <div><div class="kicker">${esc(JUDGE_LABEL[n.judge] ?? n.judge)} · #${esc(n.id)}</div><h2>${esc(n.title)}</h2></div>
      <button class="ghost small" id="side-close" aria-label="닫기">✕</button>
    </div>
    <div class="chips">
      <span class="tag-chip">${statusDot(n)}${statusText(n)}</span>
      ${n.category ? `<a class="tag-chip" href="#" data-goto="cat:${esc(n.category)}" style="color:inherit;text-decoration:none">
        <i class="legend-dot" style="background:${n.color ?? 'var(--muted)'}"></i>${esc(n.category)}</a>` : ''}
      ${n.solutions ? `<span class="tag-chip">정리한 풀이 ${n.solutions}개</span>` : ''}
    </div>
    ${mine.length ? `<div class="members">${mine.map((l) => `<a class="member" href="#" data-goto="${esc(problemKey(l.judge, l.id))}">
      <span class="pill muted">${esc(LINK_KINDS[l.kind])}</span><span>${esc(shortLabel(l.judge, l.id))} ${esc(l.title ?? '')}</span></a>`).join('')}</div>` : ''}
    <div class="actions">
      <a class="primary" href="${esc(problemUrl(n.judge, n.id))}" target="_blank" rel="noopener">문제 열기</a>
      <a href="/library.html?judge=${encodeURIComponent(n.judge)}&problem=${encodeURIComponent(n.id)}">코드 정리</a>
    </div>`;
}

function rebuild() {
  closeSide();
  autoFit = true;
  build();
}
$('group-category').addEventListener('change', rebuild);
$('show-all').addEventListener('change', rebuild);
window.addEventListener('resize', resize);

// ---------- Claude로 정리 ----------
// 요청을 map_jobs에 넣으면 내 Claude 워커가 가져가서 새 문제에 분류와 연결을 붙인다.
const WORKER_ONLINE_MS = 90_000;
let toastTimer = null;

function toast(html, { spin = false, error = false, hideAfter = 0 } = {}) {
  clearTimeout(toastTimer);
  const el = $('toast');
  el.hidden = false;
  el.classList.toggle('error', error);
  el.innerHTML = `${spin ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span>${html}</span>`;
  if (hideAfter) toastTimer = setTimeout(() => { el.hidden = true; }, hideAfter);
}

function renderOrganizeButton(busy = false) {
  const fresh = problems.filter((p) => !p.category).length;
  const btn = $('organize');
  btn.disabled = busy;
  btn.classList.toggle('busy', busy);
  btn.innerHTML = `<span class="spark" aria-hidden="true">✦</span><span>${busy ? '정리 중' : 'Claude로 정리'}</span>${!busy && fresh ? `<span class="badge">${fresh}</span>` : ''}`;
  btn.title = fresh ? `아직 분류 안 된 문제 ${fresh}개를 Claude가 정리해요` : '새로 정리할 문제가 없어요';
}

async function workerOnline() {
  const { data } = await sb.from('claude_workers').select('last_seen').maybeSingle();
  return !!data && Date.now() - Date.parse(data.last_seen) < WORKER_ONLINE_MS;
}

async function watchJob(id) {
  renderOrganizeButton(true);
  let offlineChecked = 0;
  for (;;) {
    const { data: job, error } = await sb.from('map_jobs').select('status,result,error').eq('id', id).single();
    if (error) { toast(esc(error.message), { error: true, hideAfter: 6000 }); break; }
    if (job.status === 'queued') {
      // 워커가 꺼져 있으면 켜라고 알려준다. (자주 묻지 않게 30초마다만 확인)
      if (Date.now() - offlineChecked > 30_000) {
        offlineChecked = Date.now();
        const online = await workerOnline();
        toast(online ? 'Claude에게 보냈어요…' : 'Claude 워커가 꺼져 있어요. <code>node worker.js</code>로 켜면 바로 정리해요.', { spin: online });
      }
    } else if (job.status === 'running') {
      toast(`Claude가 새 문제 ${problems.filter((p) => !p.category).length}개를 정리하는 중…`, { spin: true });
    } else if (job.status === 'done') {
      ({ problems, links } = await loadProblems());
      categoryColor = categoryColors(problems);
      autoFit = true;
      build();
      const r = job.result ?? {};
      toast(r.classified
        ? `<b>${r.classified}</b>문제를 분류하고 연결 <b>${r.links ?? 0}</b>개를 더했어요`
        : '새로 정리할 문제가 없어요', { hideAfter: 5000 });
      break;
    } else {
      toast(`정리하지 못했어요: ${esc(job.error ?? '')}`, { error: true, hideAfter: 8000 });
      break;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  renderOrganizeButton(false);
}

$('organize').addEventListener('click', async () => {
  if (!problems.some((p) => !p.category)) {
    toast('새로 정리할 문제가 없어요. 새 문제를 풀면 여기서 정리할 수 있어요.', { hideAfter: 4000 });
    return;
  }
  renderOrganizeButton(true);
  const { data, error } = await sb.from('map_jobs').insert({}).select('id').single();
  if (error) {
    toast(esc(error.message), { error: true, hideAfter: 6000 });
    renderOrganizeButton(false);
    return;
  }
  watchJob(data.id);
});

// ---------- 시작 ----------
build();
resize();
const focus = new URLSearchParams(location.search).get('focus');
if (focus && !nodes.some((n) => n.key === focus) && problems.some((p) => p.key === focus)) {
  // 분류 안 된 문제를 보러 왔으면 전부 보여준다.
  $('show-all').checked = true;
  build();
}
const focusNode = focus && nodes.find((n) => n.key === focus);
if (focusNode) select(focusNode);
renderOrganizeButton();
requestAnimationFrame(tick);

// 이전에 누른 정리가 아직 진행 중이면 이어서 지켜본다.
const { data: lastJob } = await sb.from('map_jobs').select('id,status').in('status', ['queued', 'running'])
  .order('created_at', { ascending: false }).limit(1).maybeSingle();
if (lastJob) watchJob(lastJob.id);
