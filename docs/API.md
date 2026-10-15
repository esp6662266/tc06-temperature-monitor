# 데이터 및 API 계약 v1

모든 변경은 HTTPS로 전달한다. 시간은 UTC ISO 8601로 저장하고 화면·CSV 날짜 선택은 Asia/Seoul 기준이다.

## 경로

| 경로 | 접속 | 역할 |
|---|---|---|
| POST /api/ingest | 공개·무인증 | 기록·음성 저장 |
| GET /api/latest | 공개·무인증 | 최신 기록, 서버 시각, fresh 여부 |
| GET /api/history?day=YYYY-MM-DD | 공개·무인증 | 해당 한국 날짜 CSV |
| GET /api/audio?id=SHA256 | 공개·무인증 | 온도/실패 상태 WAV |
| GET /api/audio?id=notice-stale | 공개·무인증 | 갱신 끊김 WAV |

## 업로드

JSON 본문 `record`:

- `id`: UUID v4. 로컬 저장 시 한 번 생성, 재전송 때 유지.
- `asset`: TC-06 고정.
- `device_id`: 영문·숫자·밑줄·하이픈 1~64자.
- `captured_at`: 실제 판독에 사용한 프레임을 읽은 시각.
- `recorded_at`: 분 단위 로컬 기록을 만든 시각.
- `status`: 아래 판독 상태.
- `value_c`: 정상일 때 소수점 한 자리 숫자. 비정상이면 null.
- `source_clock`: 원본 영상 상단에서 읽은 시:분:초.
- `confidence`: Tesseract 문자 인식 점수 0~100. 정확도 확률이나 현장 신뢰도 보장이 아님.

선택 필드: `audio_base64`, `audio_hash` (WAV의 SHA-256), `notice_audio_base64`. 같은 음성 해시를 서버가 보유하면 바이트를 재전송하지 않아도 된다. 누락·오류 때 PC는 캐시 상태를 비우고 재전송한다. 서버 본문 제한은 약 2 MB, 개별 WAV 제한은 700 KB다.

성공 응답은 `saved: true`, 저장된 `id`를 반환한다. 성공 응답 없이 큐를 지우지 않는다. `received_at`, `has_audio`, `audio_id`는 서버가 추가한다. 업로드한 텍스트와 생성 음성의 의미 일치는 수집기의 책임이다. API는 사용자 요청대로 공개 수신하며 제출자의 신원을 인증하지 않는다.

## 판독 상태

`ok`, `anchor_missing`, `ambiguous_anchor`, `occluded`, `ocr_failed`, `value_suspect`, `low_confidence`, `freshness_unverified`, `stale_source`, `source_error`, `window_missing`.

실제 창/캡처 예외는 현재 수집기에서 `source_error`로 통합되어 로그의 예외 유형을 확인한다. `window_missing`은 API/웹에서 허용하는 향후 세분 상태다.

한 장의 정지 이미지에서 숫자를 읽었더라도 원본 시계 진행을 확인하지 못하면 `freshness_unverified`이고 `value_c`는 null이다. 진단용 `candidate_value_c`는 GUI/로컬 진단 결과에만 존재하며 서버의 정상값으로 전송하지 않는다.

## 일관성

기록은 한국 날짜+UUID로 최초 한 번만 저장한다. 최신값은 `captured_at`, `recorded_at`, `id` 순서로 비교하고 조건부 갱신한다. 과거 재전송은 이력만 추가한다. PC 시계가 서버보다 30초 넘게 앞서면 거부하므로 Windows 시간 동기화를 확인한다.

현재값 신선도는 캡처 후 150초 이내가 기본이다. 수신 시각만으로 갱신 여부를 판단하지 않는다. PC는 과거 큐를 새 시각으로 재포장하지 않는다.

## 웹 기본값 (v0.2)

`GET /api/latest`는 기록이 없으면 `record: null`을 그대로 반환한다. 웹은 최초/통신 실패/비정상 판독/150초 초과 시 38도를 기본 표시·음성으로 사용한다. 일반 화면에는 기본값임을 표시하며 API·CSV·SQLite의 실제 측정 행을 38로 바꾸지 않는다. `/audio/fallback-38.mp3`는 공개 정적 파일이다. `/api/audio?id=notice-stale`은 이전 클라이언트 호환 경로로 유지한다.
