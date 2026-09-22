import { sb, $, esc, requireUser } from './common.js';

await requireUser();

const [{ data: problems, error }, { data: mine }] = await Promise.all([
  sb.from('oj_problems').select('id,title,difficulty,tags,published').order('id'),
  sb.from('submissions').select('problem_id,verdict').eq('judge', 'self'),
]);
if (error) alert(`문제를 불러오지 못했어요: ${error.message}`);

const status = new Map();
for (const s of mine ?? []) {
  if (s.verdict === 'Accepted') status.set(s.problem_id, 'solved');
  else if (!status.has(s.problem_id)) status.set(s.problem_id, 'tried');
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = (problems ?? []).filter((p) => !q || String(p.id) === q || p.title.toLowerCase().includes(q)
    || p.tags.some((t) => t.toLowerCase().includes(q)));
  $('empty').hidden = rows.length > 0;
  $('list').innerHTML = rows.map((p) => {
    const st = status.get(String(p.id));
    return `<tr data-id="${p.id}">
      <td class="num">${p.id}</td>
      <td>${esc(p.title)} ${!p.published ? '<span class="pill draft">비공개</span>' : ''}</td>
      <td class="muted">${esc(p.difficulty ?? '')}</td>
      <td><span class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span></td>
      <td>${st === 'solved' ? '<span class="badge v-Accepted">해결</span>' : st === 'tried' ? '<span class="badge v-WrongAnswer">시도</span>' : ''}</td>
    </tr>`;
  }).join('');
}
$('list').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) location.href = `problem.html?id=${tr.dataset.id}`;
});
$('filter').addEventListener('input', render);
render();
