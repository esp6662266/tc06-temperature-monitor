# Netlify 설정 · v0.3

운영: https://tc06-temperature-monitor.netlify.app/
일반 화면: https://tc06-temperature-monitor.netlify.app/?mode=normal

Site ID: `67ba3ef2-67cd-4fdb-afdb-bd303748108c`
소스: https://github.com/esp6662266/tc06-temperature-monitor

GitHub 자동 배포 연결은 설정하지 않았다. 현재 Netlify CLI 수동 배포다. 소스 푸시만으로 운영 사이트가 바뀌지는 않는다. 반드시 온도 전용 Site ID와 이 저장소의 `netlify.toml`을 사용한다. 기존 GME/SEJIN 사이트를 수정하지 않는다.

```sh
npm ci
netlify deploy --prod --site 67ba3ef2-67cd-4fdb-afdb-bd303748108c --dir web --functions netlify/functions
```

## 구성

- 게시 폴더 `web`, Functions 폴더 `netlify/functions`, esbuild 번들링.
- 조회·수신 키와 로그인은 없다. Netlify 관리 계정 자격증명은 저장소에 넣지 않는다.
- 빌드 환경 Node.js 설정은 22이고 이번 실제 Functions 런타임 메타데이터는 Node.js 24다.
- Windows 수집기에는 사이트 루트 주소가 기본 입력되어 있다. 영상 대상 설정 후 자동 수집한다.
- TV에서 페이지를 열고 ‘음성 시작’을 한 번 눌러 소리 재생을 허용한다. 전체 화면에서는 온도만 보이고 조작 시 메뉴가 나온다.

## 저장 구조·30일 정책

사이트별 Blobs 저장소 `tc06-monitor-v1`, strong consistency를 사용한다.

- `records/한국날짜/UUID`: 불변 온도 텍스트 기록.
- `latest`: 최신 기록. 동시 요청·과거 재전송은 ETag 조건부 쓰기로 보호한다.
- `maintenance/retention`: 최근 정리 실행 시각·삭제 수·한도 도달 여부.
- 이전 `audio/SHA256`, `audio/notice-stale`는 정리 함수가 삭제한다. 새 음성 필드는 저장하지 않는다.

서버는 한국 날짜 기준 오늘 포함 최근 30개 날짜를 남긴다. `cleanup.mjs`의 `config.schedule = "15 * * * *"`는 UTC 기준 매시 15분이며 한국시간도 매시 15분이다. 운영 배포에서 실행한다. 1회 최대 2,000개·약 22초까지만 지우고 남으면 다음 실행에서 계속한다. 최근 날짜와 알려지지 않은 키는 보존한다. 만료 최신값은 ETag 조건부 null 처리해 동시에 들어온 새 값을 보존한다.

만료 기록 조회와 재전송은 물리 삭제 전에도 HTTP 410으로 거부한다. 새 수집기는 id/사유를 확인해 해당 재전송 대기만 해제한다. PC SQLite 이력은 서버 정책과 별도로 보존된다. 필요한 CSV는 만료 전에 다운로드한다.

Netlify Functions 화면에서 `cleanup`의 Scheduled 표시와 다음 실행 시각을 확인한다. `/api/retention`에서 최근 정리 결과를 확인한다. 예약 함수는 공개 URL로 직접 실행할 수 없다. 수집기가 꺼져도 Netlify 예약 정리는 계속된다.

## 웹 숫자 TTS

고정 한국어 여성 숫자·단위 MP3 17개(합계 65,085바이트)가 웹 배포 자산이다. Web Audio로 현재 숫자를 조합하며 온도별 파일을 만들지 않는다. 운영체제 TTS 설치·Windows 음성 생성·외부 TTS API는 사용하지 않는다. 조각을 이어 붙여 억양이 끊길 수 있으므로 실제 TV에서 숫자·소수점·단위와 명료도를 확인한다.

서비스 워커는 화면·스크립트·스타일·고정 숫자 묶음을 캐시한다. `/api/*`는 캐시하지 않는다. 온라인으로 한 번 정상 방문해 캐시가 준비된 브라우저에서 오프라인 기본값 38도 안내를 사용할 수 있다. 캐시 삭제·미지원 브라우저의 오프라인 첫 접속은 보장하지 않는다.

## 운영 전 확인

- 실제 Windows 수집기의 SQLite와 서버 id/시각을 대조해 1분 저장·단절 복구를 확인한다.
- 함수·저장소·전송 사용량은 Netlify 요금제에 따른다. 무료 무제한을 보장하지 않는다.
- 운영과 Deploy Preview가 사이트 저장소를 공유할 수 있다. 운영에 정상 온도 시험 데이터를 채우지 않는다.
- 이 버전은 한 사이트·한 설비·한 수집 PC용이다.
- 공개 수신 API는 원본 캡처의 진위를 독립적으로 증명하지 않는다.

## 로컬 미리보기

Node.js 22 이상에서 `npm ci`, `npm run dev` 후 `http://127.0.0.1:8766`을 연다. 임시 메모리 저장소이며 종료 시 지워진다. Netlify 예약 함수의 자동 실행은 로컬 개발 서버에 포함되지 않는다. 정리 로직은 `npm test`로 검증한다.

공식 문서:

- https://docs.netlify.com/build/functions/scheduled-functions/
- https://docs.netlify.com/build/data-and-storage/netlify-blobs/
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
