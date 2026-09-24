# OJ 제출 기록기

[dshs.app 온라인 저지](https://dshs.app/oj)에 낸 제출(코드, 결과, 틀린 테스트케이스, 채점 메시지)을
자동으로 저장하고, 대시보드에서 문제별로 모아 보며 어디서 자주 틀리는지 분석하는 도구.

대시보드: https://oj-tracker.vercel.app

```
extension/   크롬 확장 프로그램 (MV3)
  adapters/  채점 사이트별 어댑터 (지금은 dshs.js 하나)
  content.js 사이트 페이지 안에서 새 제출과 문제 설명을 찾아 background로 전달
  background.js  Supabase 로그인 세션 관리 + 저장 (실패 시 1분마다 재시도)
dashboard/   대시보드 정적 사이트 (Vercel 배포)
  oj/        연습장 (문제 목록, 풀기, 관리, 브라우저 채점기)
analyzer/    로컬 Claude 워커(worker.js), 문제 생성(problem-gen.js), 모델 비교 도구(compare.js, report.js)
supabase/
  migrations/          DB 스키마
  functions/analyze/   분석 요청을 받는 Edge Function (Gemma 실행, Claude 대기열)
  functions/_shared/   프롬프트, 출력 형식, 모델 배정 규칙 (워커와 함께 씀)
```

## 동작 방식

1. 확장 프로그램 팝업에서 로그인하면 **그 시점 이후** 제출만 기록한다.
2. dshs.app에서 제출 버튼을 누르면 3초 간격으로 `/api/oj/submissions?mine=1`을 확인하고,
   채점이 끝난 제출은 `/api/oj/submissions/{id}`에서 코드와 테스트케이스 결과를 받아 저장한다.
   (사이트를 열어둔 동안에는 1분마다, 탭으로 돌아올 때마다 한 번씩 더 확인한다.)
3. 대회 페이지(`/oj/contests/{uid}`)에서는 대회 제출 목록도 함께 확인한다.

## 약점 분석

대시보드에서 "분석"을 누르면 문제마다 어느 모델이 맡을지 정한다 (`_shared/analysis.js`의 `route`).

| 문제 | 담당 |
|---|---|
| 맞힌 문제, 틀린 종류가 한 가지, 맞힐 때 바꾼 코드가 10줄 이하 | **Gemma 4 31B** (OpenRouter 무료, 서버에서 실행) |
| 아직 못 푼 문제 / 틀린 종류가 여러 가지 / 코드를 많이 바꿈 | **Claude** (각자 컴퓨터의 워커). 워커가 없으면 "Claude 분석 필요" |
| 틀린 제출이 없거나 빈 코드뿐 | 분석 안 함 |

이 기준은 예전 제출 7문제로 Claude와 Gemma를 비교한 결과에서 나왔다. Gemma는 쉬운 문제에서는 정확했지만,
원인이 겹치거나 정답이 없는 문제에서는 틀린 원인을 "확신 높음"으로 내놓았다.

- Gemma 분석은 한 사람당 하루 15회까지. OpenRouter 키는 Supabase secret(`OPENROUTER_API_KEY`)에 있다.
  무료 모델은 OpenRouter 계정 전체에 하루 호출 한도가 있어서, 사용자가 많아지면 한도에 걸릴 수 있다.
- 종합 리포트는 Claude가 연결돼 있으면 Claude, 아니면 Gemma가 만든다.
- **전체 분석하기** 버튼: 분석이 필요한 문제(분석 전, 새 제출 생김, 실패)를 모두 분석 요청하고, 끝날 때까지 기다렸다가
  종합 리포트까지 만든다. Claude가 필요한데 연결이 없는 문제는 건너뛴다.

### Claude 연결하기 (선택)

Claude 구독과 [Claude Code](https://claude.com/claude-code) 설치가 필요하다.

1. 대시보드 → "Claude 연결 방법" → **연결 코드 받기** (10분 동안 한 번만 쓸 수 있는 코드)
2. 터미널에서:

```bash
cd analyzer
node worker.js link <코드>   # 연결 (한 번만). 비밀번호 대신 코드를 쓴다
node worker.js               # 켜두는 동안 "Claude 분석 필요" 문제를 처리
node worker.js logout        # 연결 해제
```

워커는 `claude -p`를 도구 없이(`--tools ""`) 실행해서 분석 결과만 받는다. 연결 정보는 `~/.config/oj-analyzer/`에 저장된다.
연결 코드는 `worker-link` Edge Function이 발급하고, 쓰면 바로 지워진다 (DB에는 해시만 저장).

### 워커 자동 실행 (macOS)

`~/Library/LaunchAgents/com.oj-analyzer.worker.plist`에 등록하면 로그인할 때 워커가 켜지고, 꺼지면 30초 뒤 다시 켜진다.
로그는 `~/.config/oj-analyzer/worker.log`. plist에 node 경로가 고정돼 있어서 node 버전을 바꾸면 경로도 고쳐야 한다.

```bash
launchctl kickstart -k gui/$(id -u)/com.oj-analyzer.worker   # 다시 시작 (코드 수정 후)
launchctl bootout gui/$(id -u)/com.oj-analyzer.worker        # 끄기 (다음 로그인 때는 다시 켜짐)
rm ~/Library/LaunchAgents/com.oj-analyzer.worker.plist       # bootout 후 이것까지 하면 자동 실행 해제
```

## 연습장 (자체 온라인 저지)

https://oj-tracker.vercel.app/oj/ — 관리자가 올린 문제를 누구나 풀 수 있는 작은 온라인 저지. 제출은 `submissions`에
`judge = 'self'`로 저장돼서 대시보드와 약점 분석에 그대로 나온다.

- **채점은 브라우저에서** 한다. [YoWASP Clang](https://github.com/YoWASP/clang)(WebAssembly용 clang, 처음 한 번 약 23MB)으로
  C++17을 컴파일하고, 직접 만든 최소 WASI로 실행한다 (`dashboard/oj/judge-core.js`). 서버 비용이 없다.
  - 테스트케이스를 모두 통과해야 "맞았습니다". 처음 틀린 케이스에서 멈춘다.
  - WebAssembly는 느려서 시간 제한은 문제에 적힌 값의 2배까지 봐준다.
  - 한계: 재귀 깊이는 브라우저 호출 스택 크기에 막힌다 (함수에 따라 1~10만 단계). 널 포인터 접근은 런타임 에러가 아니라 오답으로 나올 수 있다.
  - 채점을 브라우저에서 하므로 테스트케이스는 푸는 사람도 볼 수 있다 (연습용이라 허용).
- **문제 등록은 관리자만** (`oj_admins` 테이블). 관리 페이지에서 주제와 난이도를 적어 **Claude로 문제 만들기**를 요청하면
  관리자의 Claude 워커가 처리한다 (`analyzer/problem-gen.js`).
  1. Claude가 문제, 정답 코드, 느린 검증용 풀이, 테스트 입력 생성기를 쓴다. "내 약점 반영"을 켜면 약점 분석 결과를 참고한다.
  2. 워커가 이 코드들을 WebAssembly 샌드박스(`analyzer/sandbox.js`, 파일·네트워크 접근 없음)에서 컴파일하고 실행해서
     테스트 입력을 만들고, **정답 코드를 돌려 출력을 만든다**. 작은 테스트는 검증용 풀이와 답이 같은지 확인한다.
  3. 검증에 실패하면 이유를 알려주고 한 번 더 고치게 한다. 통과하면 비공개 문제로 저장되고, 관리자가 보고 공개한다.

## 힌트 (문제 풀 때)

막히면 **정답을 알려주지 않는 단계별 힌트**를 받을 수 있다. 연습장 문제 페이지와, dshs.app 문제 페이지(확장 프로그램이 띄우는 패널) 양쪽에 있다.

| | 내용 |
|---|---|
| 1단계 | 문제를 보는 관점, 되물어볼 질문. 알고리즘 이름은 말하지 않는다 |
| 2단계 | 접근 방향. 단순한 방법이 왜 부족한지 |
| 3단계 | 핵심 아이디어와 목표 시간복잡도 (그래도 코드는 주지 않는다) |
| 내 코드 진단 | 지금 편집기에 있는 코드에서 "어디를 왜 다시 볼지" 1~3군데 (고친 코드는 주지 않는다) |

- 힌트는 **각자의 Claude 워커**가 만든다 (`hints` 테이블에 요청을 넣으면 워커가 가져간다). 한 번에 10~30초쯤 걸린다.
- 프롬프트는 `supabase/functions/_shared/hints.js`. 코드·의사코드·정답을 주지 않고, 요청한 단계보다 앞서 나가지 않게 못 박아 뒀다.
- 힌트에 문제 내용이 필요해서, 확장 프로그램은 dshs.app 문제 페이지를 열면 그 문제 설명을 저장해 둔다.

## 기록 삭제

대시보드에서 제출 하나(제출 보기 아래 "이 제출 삭제"), 문제 하나(문제 창 위 "문제 기록 삭제"),
또는 전체("기록 관리" → "모든 기록 삭제")를 지울 수 있다. 버튼을 한 번 더 눌러야 지워진다.
지운 제출은 확장 프로그램이 다시 저장하지 않는다.

## 설치 (친구들용)

1. 이 저장소를 내려받는다: 위쪽 초록색 **Code** → **Download ZIP** 후 압축 풀기 (또는 `git clone https://github.com/sxcrxta/oj-tracker.git`)
2. 크롬에서 `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램 로드** → `extension` 폴더 선택.
3. 확장 프로그램 아이콘 → 회원가입/로그인. **로그인한 뒤에 낸 제출부터** 저장된다.
4. 대시보드 **https://oj-tracker.vercel.app** 에서 같은 계정으로 로그인해 기록과 분석을 본다.
5. (선택) Claude 구독이 있으면 위의 "Claude 연결하기"로 어려운 문제도 분석할 수 있다.

업데이트할 때는 새로 내려받은 `extension` 폴더로 바꾸고 `chrome://extensions`에서 ↻를 누른다.

## 다른 채점 사이트 추가하기

`extension/adapters/dshs.js`와 같은 모양의 어댑터를 만들고 `manifest.json`의
`content_scripts`와 `host_permissions`에 사이트를 추가한다. DB는 `judge` 컬럼으로 사이트를 구분한다.
