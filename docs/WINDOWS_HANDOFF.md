# 실제 Windows PC의 Codex에서 이어가기

## 그대로 붙여 넣을 재개 요청

> https://github.com/esp6662266/tc06-temperature-monitor 를 받아 AGENTS.md, README.md, docs/WINDOWS_HANDOFF.md, docs/VERIFICATION.md부터 읽어줘. 이 저장소에는 TC-06 OCR 수집기와 Netlify API, TV 음성 표시 웹 코드가 이미 있다. 실제 Windows PC의 캡처 장치 또는 지정 HMI 창을 확인하고 설정·실기 검증·필요한 수정부터 이어가줘. PLC·HMI 운전 조작·보호값·시뮬레이터는 건드리지 마. 조회·업로드 모두 공개·무인증이라는 사용자 결정을 유지하고 로그인·조회키·업로드키를 추가하지 마. 서버 주소와 영상 대상을 한 번 설정하면 프로그램 실행 즉시 수집이 시작되게 해줘. 1분 저장, 창 이동/크기 변경, 판독 실패, 영상 정지, 인터넷 끊김/복구, 웹 숫자 여성 음성, 30일 서버 정리, 실제 TV 재생을 순서대로 확인하고 검증 문서에 실제 결과를 기록해줘. 기존 배포 주소 https://tc06-temperature-monitor.netlify.app 를 사용하고, 수정이 필요할 때만 온도 전용 Site ID 67ba3ef2-67cd-4fdb-afdb-bd303748108c에 배포해줘. 최초/단절/판독 실패 시 기본값 38도를 표시·안내하고 실제 측정 기록과 구분하는 동작, 숫자 전용 화면과 일반 설정 화면도 유지해줘. 확인되지 않은 항목을 완료라고 적지 마.

## 먼저 확인할 환경

1. Windows 10/11 64비트, Python 3.12와 Tcl/Tk, 실제 캡처보드와 HMI/미리보기 창.
2. 이 프로그램을 **캡처를 보는 별도 PC에 설치하는지**, 실제 HMI 운전 PC에 설치하는지 확인. 기본은 별도 캡처 PC를 권장한다. 부하와 설치 가능 여부는 실제 장비에서 확인한다.
3. Tesseract의 `eng` 언어 데이터. OS 한국어 음성 설치는 불필요하다.
4. 이미 배포된 **온도 전용 사이트 주소 https://tc06-temperature-monitor.netlify.app**. 수집기 GUI에 기본 입력되어 있다. 기존 GME/SEJIN 사이트를 임의 수정하지 않는다.
5. 실제 TV 모델·브라우저·회사 네트워크의 외부 HTTPS 접속·Web Audio/MP3 재생·전원 복귀 동작.

## 설치

PowerShell을 저장소 폴더에서 연다. 관리자 권한은 이 프로그램 자체에는 필요하지 않다.

```powershell
.\scripts\Setup-Windows.ps1
```

스크립트 실행이 조직 정책으로 차단되면 임의로 보안 정책을 변경하지 말고 담당자 또는 사용자의 설치 절차를 따른다. 각 스크립트의 Python 명령을 직접 실행할 수도 있다.

Tesseract는 프로젝트 공식 문서에 안내된 Windows 배포 경로를 참고해 설치한다. 이 저장소는 제3자 설치 파일을 포함하거나 자동 실행하지 않는다.

- https://tesseract-ocr.github.io/tessdoc/Downloads.html
- 기본 경로: `C:\Program Files\Tesseract-OCR\tesseract.exe`
- 숫자와 영문 라벨만 읽으므로 `eng` 데이터가 필요하다.

음성은 웹에서 동봉된 한국어 여성 숫자 조각을 조합한다. Windows 음성 패키지나 PowerShell 음성 생성은 필요 없다. TV에서 Web Audio·MP3 재생과 첫 음성 시작 조작을 확인한다.

## 실행과 설정

```powershell
.\scripts\Start-Monitor.ps1
```

1. `source`: 캡처보드를 직접 읽으면 `device`, 보이는 HMI/미리보기 창을 읽으면 `window`.
2. `window`는 창 목록에서 정확한 제목을 선택한다. 제목이 달라지면 선택을 갱신한다. 동일 제목 창 여러 개는 판독하지 않는다.
3. `device`는 장치 번호를 설정한다. 기본 0은 웹캠일 수 있으므로 미리보기와 원본을 대조해 실제 장치를 확인한다.
4. 서버 사이트 주소 기본값 `https://tc06-temperature-monitor.netlify.app`를 확인한다. `?mode=normal` 같은 쿼리 없이 **사이트 루트**를 사용한다.
5. 키와 로그인 입력은 없다. ‘수집 시작’을 누르면 설정이 저장되고 다음 실행부터 자동 시작한다.
6. 원본 시계가 진행한 뒤 `ok`가 되는지, 작은 판독 영역과 원본의 숫자가 같은지 확인한다. 첫 정상값은 즉시 저장하고 이후 1분 간격으로 기록한다.

설정·이력·로그의 위치는 `%LOCALAPPDATA%\TC06Monitor`다. 인증 키는 사용하지 않는다. 음성 준비/오류는 웹에 표시된다. 실제 TV 청취와 온도 저장을 별도로 확인한다.

## 자동 실행

수동 동작과 정확도 확인 후 선택한다.

1. GUI에서 서버 주소와 영상 대상을 설정하고 정상 시작해 설정을 저장한다.
2. 다음 명령으로 **현재 사용자 로그인 후** 자동 실행을 등록한다. 로그인 전 Windows 서비스가 아니다.

```powershell
.\scripts\Set-Autostart.ps1 -Enable
```

해제:

```powershell
.\scripts\Set-Autostart.ps1 -Disable
```

재로그인 후 GUI가 열리고 실제 수집이 시작되는지 확인한다. PC 절전·HMI 최소화·시계 미검출 상태는 자동 실행으로 해결되지 않는다.

## EXE 빌드

```powershell
.\scripts\Build-Windows.ps1
```

성공하면 `dist\TC06Monitor` **폴더 전체**를 배포한다. EXE 하나만 복사하지 않는다. Tesseract는 별도 설치 대상이다. 한국어 음성 설치는 필요 없다. Windows 실행 확인, SHA-256, 빌드 Python 버전, 실제 시험 결과를 검증 문서에 기록하고 그 뒤 릴리스 파일로 올린다. 현재 공개 소스 릴리스에 Windows EXE가 있다고 주장하지 않는다.

## 현장 시험

`docs/VERIFICATION.md`의 체크리스트를 채운다. 실제 화면을 GitHub에 올리지 말고 각 시험의 성공/실패·설정·날짜만 남긴다. 회사 계정 로그인, 설치 승인, 캡처 대상 선택 같은 사용자 단계는 현장 사용자와 함께 진행한다.

## v0.3 추가 인수인계

서버는 한국 날짜 기준 오늘 포함 최근 30일만 보관하고 매시 15분에 정리한다. 만료 재전송 410은 해당 id만 전송 대기에서 해제한다. PC SQLite 이력은 별도다. 음성은 고정 MP3 숫자 조각 17개(65,085바이트)를 웹에서 합성하므로 온도별 WAV 생성·업로드나 OS 음성 설치를 다시 추가하지 않는다.

합성 OCR 추가 시험에서 350.0을 550.0으로 오독하거나 999.9를 못 읽는 사례가 확인됐다. 실제 HMI 글꼴·해상도에서 OCR 보완과 교차 검증이 필요하다. 백 단위 전체의 정확도 검증이 끝났다고 주장하지 않는다.
