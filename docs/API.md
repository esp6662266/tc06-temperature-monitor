# 데이터 및 API 계약 v2 · 텍스트 전용

시간은 UTC ISO 8601로 저장하고 화면·CSV·보관 날짜는 Asia/Seoul 기준이다. 조회·수신은 사용자 요청대로 공개·무인증이다.

| 경로 | 역할 |
|---|---|
| POST /api/ingest | `{record}` 온도 텍스트 저장 |
| GET /api/latest | 최신 record·마지막 정상 last_good·서버 시각·fresh·30일 보관 경계 |
| GET /api/history?day=YYYY-MM-DD | 해당 한국 날짜 CSV. 만료 날짜는 410 |
| GET /api/trend?day=YYYY-MM-DD&minutes=1&span=360 | 온도 봉 JSON |
| GET /api/retention | 보관 정책·최근 자동 정리 결과 |
| GET /api/audio | 410: 서버 음성 저장 종료 |

## 기록

- `id`: UUID v4. 생성 후 재전송 시 유지.
- `asset`: TC-06 고정.
- `device_id`: 영문·숫자·밑줄·하이픈 1~64자.
- `captured_at`: 사용한 프레임의 시각. `recorded_at`: 로컬 기록 생성 시각.
- `status`: 판독 상태. `value_c`: 정상은 소수점 한 자리 숫자, 비정상은 null.
- `source_clock`: 원본 영상에서 읽은 시:분:초.
- `confidence`: Tesseract 점수 0~100. 정확도 확률이나 현장 신뢰도 보장이 아니다.
- `received_at`: 서버가 추가한다.

판독 상태는 `ok`, `anchor_missing`, `ambiguous_anchor`, `occluded`, `ocr_failed`, `value_suspect`, `low_confidence`, `freshness_unverified`, `stale_source`, `source_error`, `window_missing`이다. 실제 창/캡처 예외는 현재 `source_error`로 통합한다.

정지 이미지라도 숫자를 읽었으면 GUI/진단용 `candidate_value_c`에는 나타날 수 있다. 원본 시계 진행 전에는 `freshness_unverified`, 서버 `value_c`는 null이다. v0.4.1은 시작/복구·큰 변화의 추가 확인 대기에도 `value_suspect`와 null을 사용한다. 로컬 `verification=confirm_next_source_tick`은 GUI 진단용이며 서버 기록에 포함하지 않는다.

## 저장·호환

성공 응답은 `{saved: true, id}`다. 실패 시 같은 id로 재전송한다. 한국 날짜+UUID 최초 기록을 보존하고 최신값은 캡처 시각·기록 시각·id 순서와 ETag 조건부 쓰기로 보호한다. PC 시계가 서버보다 30초 초과 앞서면 거부한다.

이전 클라이언트의 `audio_base64`, `audio_hash`, `notice_audio_base64`는 호환을 위해 무시하며 저장하지 않는다. 새 수집기는 `{record}`만 보낸다. 요청 본문 제한은 약 2MB다. 서버는 제출자의 신원이나 원본 캡처의 진위를 독립적으로 증명하지 않는다.

만료한 캡처 날짜는 HTTP 410과 `{id, discarded: "retention_expired"}`를 반환한다. 새 수집기는 id와 사유가 일치할 때만 재전송 대기를 해제하고 저장 성공과 구분해 표시한다. 다른 오류는 큐에 남긴다. 만료 이력을 다시 만들지 않는다.

## 웹 마지막 정상값·기본값·음성 (v0.5.1)

캡처 후 150초 이내 정상값만 최신 수신값으로 표시한다. 단절/판독 실패/오래된 값은 보관 범위의 마지막 정상값과 “마지막 정상값 · N분 전”을 숫자·일반·그래프 상단에 표시한다. 경과 시간은 원래 `captured_at` 기준이며 조회 시각으로 바꾸지 않는다. 정상 최신값이 돌아오면 자동 복귀한다.

`GET /api/latest`는 기존 `record`(실패 상태 포함)를 유지하고 `last_good`(실제 정상 원본 기록 또는 null)를 추가한다. 서버 `last-good` 키는 정상 업로드 때만 캡처/기록/id 순서와 ETag 조건으로 갱신한다. 첫 조회 때 키가 없으면 30일 범위의 기존 이력에서 최신 정상 원본을 복원한다. 조회로 새 측정 행을 만들지 않으며 빈 복원 결과도 메모한다. 브라우저는 정상 원본 하나를 `tc06-last-good-v1`에 보관해 API 단절/재접속에 사용하고 동일한 30일 만료를 적용한다.

유지 값은 과거 값이므로 “현재 온도” 음성을 대기하고 정상 수신 후 다음 주기에 재개한다. 정상 이력이 없거나 만료됐을 때만 기본 38도 표시·안내다. API·CSV·SQLite 측정 행과 그래프 봉을 유지 값 또는 38로 대체하지 않는다.

음성은 `/voice/*.mp3` 17개를 `/voice.js`가 Web Audio로 조합한다. 온도별 파일·OS TTS·외부 TTS 서비스는 사용하지 않는다. 0~9999.9와 음수를 읽고 소수 부분이 0이면 정수로 발음한다.

## 30일 자동 삭제

한국 날짜 기준 오늘 포함 최근 30개 날짜만 보관한다. 10월 16일이면 9월 17일부터 보관한다. `cleanup` Scheduled Function은 매시 15분에 지난 날짜의 `records/날짜/UUID`와 이전 `audio/SHA256`, `audio/notice-stale`를 삭제한다. 알려지지 않은 키는 보존한다. 한 번에 2,000개·약 22초까지 처리하고 다음 실행에서 계속한다.

만료 `latest`와 `last-good`는 ETag 조건부 null 처리하여 동시에 들어온 새 값을 보존한다. 물리 삭제 전에도 만료 데이터 조회·재수신은 차단한다. PC SQLite 이력은 별도이며 서버 정리로 삭제되지 않는다.

`/api/retention`은 `retention_days`, `oldest_day`, `timezone`, `cleanup_schedule`, `last_cleanup`을 반환한다. `last_cleanup`에는 실행 시각, 기록/음성 삭제 수, 최신값 정리 여부(`cleared_latest`), 마지막 정상값 정리 여부(`cleared_last_good`)와 한도 도달 여부가 있다. 삭제 함수는 공개 URL로 실행할 수 없다.

## 그래프 API (v0.4)

`minutes`는 1/5/10, `span`은 60/360/1440분이다. `day`는 한국 날짜이며 생략하면 오늘이다. 미래/잘못된 날짜와 지원하지 않는 단위는 400, 보관 만료 날짜는 410이다.

오늘의 종료 시각은 현재, 과거 날짜는 그날 종료 자정이다. 최근 span만큼 역산하므로 오늘 6시간 조회는 전날을 포함할 수 있다. 보관 시작 날짜보다 이전은 자른다. 봉은 한국시간 분 경계에 정렬한다.

응답 `bars`는 `time`, `open`, `high`, `low`, `close`, `count`, `invalid_count`, `complete`다. 정상 기록이 없으면 온도 네 항목은 null이며 실패/공백을 0이나 38로 바꾸지 않는다. `complete`는 해당 시간 구간이 끝났는지다. `samples`, `invalid_samples`, `low`, `high`, `start`, `end`, `server_now`, `oldest_day`도 반환한다.

색인 `trend/YYYY-MM-DD`는 버전·날짜·이전 이력 스캔 완료 여부와 `{UUID: [캡처 epoch ms, 값 또는 null, 상태, 기록 epoch ms]}`를 보관한다. ETag 조건부 병합으로 동시에 저장한 값·과거 재전송·중복 재전송을 보존한다. 최초 조회에서 이전 `records`를 한 번 병합하고, 이후 조회는 색인 1~2개만 읽는다. 30일 정리에 `trend/날짜`도 포함된다. 음성·이미지를 색인에 저장하지 않는다.
