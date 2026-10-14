// 빈칸 채우기 문제. 코드 틀(skeleton.template)에서 한 줄 전체가 {{id}}인 줄이 빈칸이다.
// 브라우저(문제 페이지)와 Claude 워커(힌트) 양쪽에서 쓴다.
const MARK = /^[ \t]*\{\{(\w+)\}\}[ \t]*$/;

// 틀을 [{ type: 'code', code }, { type: 'blank', id }] 조각으로 나눈다.
export function splitTemplate(template) {
  const parts = [];
  let buf = [];
  const flush = () => { if (buf.length) parts.push({ type: 'code', code: buf.join('\n') }); buf = []; };
  for (const line of template.replace(/\r/g, '').split('\n')) {
    const m = line.match(MARK);
    if (m) { flush(); parts.push({ type: 'blank', id: m[1] }); } else buf.push(line);
  }
  flush();
  return parts;
}

// 빈칸에 코드를 끼워 넣은 전체 코드. lines[i]는 전체 코드 i+1번째 줄이 어디서 왔는지 ({ blank, line } 또는 { line }).
export function assemble(template, values) {
  const out = [];
  const lines = [];
  let fixedLine = 0;
  for (const line of template.replace(/\r/g, '').split('\n')) {
    const m = line.match(MARK);
    if (!m) { out.push(line); lines.push({ line: ++fixedLine }); continue; }
    const code = (values[m[1]] ?? '').replace(/\r/g, '').replace(/\n+$/, '');
    code.split('\n').forEach((l, i) => { out.push(l); lines.push({ blank: m[1], line: i + 1 }); });
  }
  return { source: `${out.join('\n')}\n`, lines };
}

// 컴파일 에러의 "main.cpp:줄:칸"을 "[빈칸 이름] n번째 줄:칸"으로 바꿔서, 어느 빈칸인지 바로 보이게 한다.
export function mapCompileOutput(text, lines, titles = {}) {
  return text.replace(/main\.cpp:(\d+)(?::(\d+))?/g, (all, ln, col) => {
    const where = lines[Number(ln) - 1];
    if (!where) return all;
    const name = where.blank ? `[${titles[where.blank] ?? where.blank}] ${where.line}번째 줄` : `[주어진 코드] ${where.line}번째 줄`;
    return col ? `${name}:${col}` : name;
  });
}

// 문제 설명 전체 (분석·힌트에 넘기는 형태). 빈칸 채우기 문제는 코드 틀과 빈칸 설명도 붙인다.
export function statementText(p) {
  let text = `${p.statement}\n\n## 입력\n\n${p.input_spec}\n\n## 출력\n\n${p.output_spec}`;
  if (p.skeleton) {
    text += `\n\n## 코드 틀 (빈칸 채우기)\n\n{{이름}} 줄이 푸는 사람이 채우는 빈칸이다.\n\n\`\`\`cpp\n${p.skeleton.template}\n\`\`\``;
    text += `\n\n${p.skeleton.blanks.map((b) => `- {{${b.id}}} ${b.title}: ${b.guide}`).join('\n')}`;
  }
  return text;
}
