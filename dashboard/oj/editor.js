// 코드 편집기. dshs.app과 같은 Monaco(VS Code 편집기)를 쓴다.
// 괄호 자동 닫기, 자동 들여쓰기, 자동 완성 제안, 괄호 짝 표시가 기본으로 들어 있다.
const VERSION = '0.52.2';
const BASE = `https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/${VERSION}/min`;

let loading = null;

function loadMonaco() {
  loading ||= new Promise((resolve, reject) => {
    // 다른 출처에서 온 Worker는 바로 못 띄우므로, 작은 스크립트로 감싸서 띄운다.
    window.MonacoEnvironment = {
      getWorkerUrl: () => URL.createObjectURL(new Blob([
        `self.MonacoEnvironment = { baseUrl: '${BASE}/' };\nimportScripts('${BASE}/vs/base/worker/workerMain.js');`,
      ], { type: 'text/javascript' })),
    };
    const script = document.createElement('script');
    script.src = `${BASE}/vs/loader.min.js`;
    script.onload = () => {
      window.require.config({ paths: { vs: `${BASE}/vs` } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    script.onerror = () => reject(new Error('편집기를 불러오지 못했어요'));
    document.head.appendChild(script);
  });
  return loading;
}

const darkTheme = () => {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

// container 안에 편집기를 만든다. { getValue, setValue, focus, layout }를 돌려준다.
export async function createEditor(container, { value = '', language = 'cpp', onChange } = {}) {
  const monaco = await loadMonaco();
  const editor = monaco.editor.create(container, {
    value,
    language,
    theme: darkTheme() ? 'vs-dark' : 'vs',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    lineHeight: 20,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderLineHighlight: 'line',
    smoothScrolling: true,
    // 기본값이지만 분명히 해 둔다 (dshs.app과 같은 동작)
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    autoIndent: 'full',
    autoSurround: 'languageDefined',
    bracketPairColorization: { enabled: true },
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
  });

  if (onChange) editor.onDidChangeModelContent(() => onChange(editor.getValue()));

  // 테마 설정을 따라간다.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => monaco.editor.setTheme(darkTheme() ? 'vs-dark' : 'vs'));

  return {
    getValue: () => editor.getValue(),
    setValue: (v) => editor.setValue(v),
    focus: () => editor.focus(),
    layout: () => editor.layout(),
  };
}
