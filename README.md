# OJ 제출 기록기

[dshs.app 온라인 저지](https://dshs.app/oj)에 낸 제출(코드, 결과, 틀린 테스트케이스, 채점 메시지)을
자동으로 저장하고, 대시보드에서 문제별로 모아 보는 도구.

```
extension/   크롬 확장 프로그램 (MV3)
  adapters/  채점 사이트별 어댑터 (지금은 dshs.js 하나)
  content.js 사이트 페이지 안에서 새 제출과 문제 설명을 찾아 background로 전달
  background.js  Supabase 로그인 세션 관리 + 저장 (실패 시 1분마다 재시도)
dashboard/   대시보드 정적 사이트 (Vercel 배포)
analyzer/    로컬 Claude 워커(worker.js)와 모델 비교 도구(compare.js, report.js)
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

### Claude 연결하기 (선택)

Claude 구독과 [Claude Code](https://claude.com/claude-code) 설치가 필요하다.

```bash
cd analyzer
node worker.js login      # 대시보드와 같은 계정으로 로그인 (한 번만)
node worker.js            # 켜두는 동안 "Claude 분석 필요" 문제를 처리
node worker.js logout     # 연결 해제
```

워커는 `claude -p`를 도구 없이(`--tools ""`) 실행해서 분석 결과만 받는다. 로그인 정보는 `~/.config/oj-analyzer/`에 저장된다.

## 설치 (친구들용)

1. 이 저장소를 내려받는다.
2. 크롬에서 `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램 로드** → `extension` 폴더 선택.
3. 확장 프로그램 아이콘 → 회원가입/로그인.
4. 대시보드에서 같은 계정으로 로그인해 기록을 확인한다.

## 다른 채점 사이트 추가하기

`extension/adapters/dshs.js`와 같은 모양의 어댑터를 만들고 `manifest.json`의
`content_scripts`와 `host_permissions`에 사이트를 추가한다. DB는 `judge` 컬럼으로 사이트를 구분한다.
