# TC-06 그래프 조회 및 공백 표시 Implementation Plan

> **Execution:** Follow the project instructions and existing user authorization. Steps use checkbox syntax for tracking.

봉 간격을 바꿔도 같은 구간을 조회하고, 최신 온도와 이력을 함께 다시 읽는다. 1분봉에서 양쪽 실측 사이의 짧은 공백에만 회청색 점선을 그린다. 추정은 주황색 점선과 빈 원으로 표시한다.

Node.js, Netlify Functions, 기존 HTML/CSS/SVG 및 Chrome Playwright를 사용한다. `AGENTS.md`의 실측·추정·보관 정책을 따른다.

- [x] `server/trend.mjs`와 `server/api.mjs`에서 정확한 조회 범위와 봉 격자를 분리한다. 봉 간격 전환 시 직전 조회 종료 시각을 유지할 수 있게 하고 날짜 경계와 양끝 부분 봉을 시험한다.
- [x] 저장 기록의 적용 간격을 근거로 공백을 분류한다. 적용 간격이 없는 오래된 기록, 진행 중인 구간, 예정된 공백과 예정 초과를 시험한다.
- [x] `web/graph.js`, `web/app.js`, `web/index.html`, `web/style.css`에서 두 조회의 결과와 선택한 봉 상세를 표시한다. 짧은 연결은 양끝 실측값으로만 그린다. 길거나 닫히지 않은 공백, 추정과 겹치는 구간, 통계와 실측 봉을 시험한다.
- [x] Node, Python, Chrome 테스트와 미리보기 확인 후 운영 배포의 정적 자산과 읽기 API를 대조한다. [검증 결과](../../VERIFICATION.md#2026-11-16-그래프-조회와-공백-표시)
