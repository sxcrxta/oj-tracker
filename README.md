# OJ 제출 기록기

[dshs.app 온라인 저지](https://dshs.app/oj)에 낸 제출(코드, 결과, 틀린 테스트케이스, 채점 메시지)을
자동으로 저장하고, 대시보드에서 문제별로 모아 보는 도구.

```
extension/   크롬 확장 프로그램 (MV3)
  adapters/  채점 사이트별 어댑터 (지금은 dshs.js 하나)
  content.js 사이트 페이지 안에서 새 제출을 찾아 background로 전달
  background.js  Supabase 로그인 세션 관리 + 저장 (실패 시 1분마다 재시도)
dashboard/   대시보드 정적 사이트 (Vercel 배포)
supabase/    DB 스키마
```

## 동작 방식

1. 확장 프로그램 팝업에서 로그인하면 **그 시점 이후** 제출만 기록한다.
2. dshs.app에서 제출 버튼을 누르면 3초 간격으로 `/api/oj/submissions?mine=1`을 확인하고,
   채점이 끝난 제출은 `/api/oj/submissions/{id}`에서 코드와 테스트케이스 결과를 받아 저장한다.
   (사이트를 열어둔 동안에는 1분마다, 탭으로 돌아올 때마다 한 번씩 더 확인한다.)
3. 대회 페이지(`/oj/contests/{uid}`)에서는 대회 제출 목록도 함께 확인한다.

## 설치 (친구들용)

1. 이 저장소를 내려받는다.
2. 크롬에서 `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램 로드** → `extension` 폴더 선택.
3. 확장 프로그램 아이콘 → 회원가입/로그인.
4. 대시보드에서 같은 계정으로 로그인해 기록을 확인한다.

## 다른 채점 사이트 추가하기

`extension/adapters/dshs.js`와 같은 모양의 어댑터를 만들고 `manifest.json`의
`content_scripts`와 `host_permissions`에 사이트를 추가한다. DB는 `judge` 컬럼으로 사이트를 구분한다.
