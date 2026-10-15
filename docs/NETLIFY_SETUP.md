# Netlify 설정

**2026-10-16 온도 전용 사이트 배포·공개 API 저장/조회 확인 완료.**

- 운영: https://tc06-temperature-monitor.netlify.app/
- 일반 화면: https://tc06-temperature-monitor.netlify.app/?mode=normal
- Site ID: `67ba3ef2-67cd-4fdb-afdb-bd303748108c`
- 배포 ID: `6ad0eb1b6add2dfc26420d44`
- 소스: https://github.com/esp6662266/tc06-temperature-monitor

GitHub 자동 배포 연결은 아직 설정하지 않았다. 현재는 CLI 수동 배포다. 소스를 수정·푸시한 것만으로 운영 사이트가 바뀌지는 않는다. 배포 시 반드시 위 온도 전용 Site ID를 지정하고 이 저장소의 `netlify.toml`을 확인한다. 인증 정보는 저장소에 넣지 않는다.

```sh
npm ci
netlify deploy --prod --site 67ba3ef2-67cd-4fdb-afdb-bd303748108c --dir web --functions netlify/functions
```

다른 계정에 새로 만들 때:

1. Netlify에서 이 GitHub 저장소를 연결해 **온도 전용 프로젝트**를 만든다. 저장소의 `netlify.toml`을 사용한다.
2. 배포할 브랜치 `main`, 게시 폴더 `web`, Functions 폴더 `netlify/functions`. Node.js 22. 별도 프런트엔드 빌드 명령은 필요하지 않다. 저장소의 Node 의존성은 설치해야 한다.
3. 조회·업로드 키와 로그인 설정은 필요 없다. 사용자 요청에 따라 수신·조회 API 모두 공개다.
4. 배포한 사이트 루트 주소를 Windows PC GUI에서 확인하고 영상 대상을 설정한다. 이후 프로그램을 실행하면 자동 수집한다.
5. 첫 정상 판독 기록을 전송한 후 서버 응답의 `saved: true`, 홈페이지의 판독·수신 시각, 새로고침 후 유지 상태를 대조한다.
6. TV에서 사이트 주소를 열면 숫자 전용 화면이 열린다. 최초/단절/판독 실패 때는 기본값 38도다. 화면을 눌러 메뉴를 열거나 일반 화면 주소를 사용한다. ‘음성 안내 시작’을 누르고 1분 간격으로 **최신값에 해당하는 음성**을 재생하는지 확인한다. 음성을 듣고 숫자·소수점·단위를 원본과 대조한다.

## 저장 구조

사이트별 Blobs 저장소 `tc06-monitor-v1`, strong consistency를 사용한다.

- `records/한국날짜/UUID`: 불변 기록. 재전송 id가 같으면 새 행을 만들지 않는다.
- `latest`: 최신 기록. ETag compare-and-swap으로 동시 요청과 과거 재전송을 처리한다.
- `audio/SHA256`: 한국어 여성 WAV. 동일 내용은 재사용한다.
- `audio/notice-stale`: v0.1 호환용 갱신 끊김 안내. v0.2 웹의 기본값 안내는 정적 `/audio/fallback-38.mp3`를 사용한다.

PC 로컬 SQLite와 서버 기록을 대조하기 전까지 업로드 완료로 간주하지 않는다. 운영 기록은 자동 삭제하지 않는다. 보관 기간·백업·사용량 경고는 계정 요금제에 맞춰 설정한다. 1분 기록이면 PC 한 대에서 하루 약 1,440건이며 실패 상태도 행으로 남는다. 웹은 보이는 동안 60초마다 조회하고 음성 안내 시에도 최신 상태를 조회한다.

## 운영 전 확인

- 함수·저장소 사용량과 요금제 한도 확인. 무료 무제한 보장 없음.
- 배포 미리보기와 운영이 같은 사이트 저장소를 공유할 수 있으므로 실제 운영 사이트를 테스트 데이터로 채우지 않는다. 로컬 검증은 `server/dev.mjs`의 임시 저장소를 사용한다.
- 조회·업로드 API는 모두 공개·무인증이며 주소를 아는 누구나 사용할 수 있다. 로그인 쿠키나 세션 만료는 없다.
- 수신 API는 PC의 실제 캡처·음성 생성의 진위를 독립적으로 증명하지 않는다. 제출 형식과 최신값 순서만 검사한다.
- 이 버전은 한 사이트·한 설비·한 수집기용이다. 다중 PC/설비는 최신값 키 분리와 운영 정책을 추가한 뒤 사용한다.

공식 문서:

- https://docs.netlify.com/build/functions/overview/
- https://docs.netlify.com/build/functions/environment-variables/
- https://docs.netlify.com/build/data-and-storage/netlify-blobs/

## 로컬 웹 미리보기

Node.js 22 이상에서 `npm ci` 후 `npm run dev`를 실행한다. 키와 로그인은 없다. `http://127.0.0.1:8766`은 개발 PC에서만 열리며 데이터는 서버 종료 시 사라진다. 이 개발 서버를 현장 운영 서버로 쓰지 않는다.

## 오프라인 동작

서비스 워커가 화면·스크립트·스타일·고정 38도 MP3를 캐시한다. `/api/*`는 캐시하지 않는다. 페이지 방문 후 캐시가 준비되어야 오프라인 재접속이 가능하다. 온도 38은 화면/음성 기본값이며 Blobs 측정 기록을 채우지 않는다. 일반 설정은 localStorage에 기기별 저장한다.

일반 화면의 **전체 화면** 버튼도 숫자 전용 모드로 전환한 후 전체 화면을 요청한다. 온도 이외의 제목·상태·단위·설정은 숨겨지고, 화면/리모컨 조작 때만 메뉴를 잠깐 표시한다.
