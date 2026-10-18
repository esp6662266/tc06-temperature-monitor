# Windows 설치판 사용

대상: Windows 10/11 64비트(x64). Python·Tesseract·영문 OCR 데이터를 포함한다.
Mac·Linux·32비트 Windows용 실행파일은 아니다. 실제 캡처보드 드라이버는 장치 제조사에 따라 필요할 수 있다.

1. GitHub 릴리스의 `TC06Monitor-Setup-0.6.0-x64.exe`를 받는다.
2. 실행해 설치하고 바탕화면의 `TC-06 Monitor`를 연다. 현재 사용자 폴더에 설치하며 관리자 권한을 요구하지 않는다.
3. HMI가 보이는 창을 읽으면 `window`, 캡처보드를 직접 읽으면 `device`를 선택한다. 정확한 창 제목 또는 장치 번호를 확인한다.
4. 기본 서버 주소를 그대로 두고 **수집 시작**을 누른다. 원본 시계가 진행한 뒤 GUI 판독값과 실제 숫자가 같은지 대조한다.
5. 한 번 저장한 설정으로 다음 실행부터 자동 수집하며 정상 확인 후 첫 저장, 이후 약 1분마다 업로드한다.

설치 중 로그인 자동 실행은 선택 사항이다. TV는 아래 주소를 열고 음성 시작을 누른다.

- 숫자: https://tc06-temperature-monitor.netlify.app/
- 그래프: https://tc06-temperature-monitor.netlify.app/?mode=graph
- 설정: https://tc06-temperature-monitor.netlify.app/?mode=normal

프로그램 위치: `%LOCALAPPDATA%\Programs\TC06Monitor`.
설정·이력·로그: `%LOCALAPPDATA%\TC06Monitor`.
삭제는 Windows의 설치된 앱 또는 시작 메뉴에서 실행한다. 삭제해도 설정·이력·로그는 보존한다.
이전 설치를 갱신할 때는 실행 중인 수집기를 종료하고 새 설치파일을 실행한다.

압축 해제만 하려면 `TC06Monitor-Portable-0.6.0-x64.zip` 전체를 풀고 `TC06Monitor.exe`를 실행한다.
EXE만 따로 복사하면 내장 실행 환경이 빠지므로 폴더 전체를 유지한다.

현재 설치판은 코드 서명 인증서로 서명하지 않았다. 조직 보안 정책에서 실행이 제한될 경우 승인 절차를 따른다.
로그인·조회키·업로드키·유료 OCR/TTS 계정 입력은 없다.
원본 HMI를 조작하지 않으며 가림·정지·미확인 값은 정상 온도로 만들지 않는다.
실제 장치·HMI 고온 OCR·TV 재생은 설치 환경에서 별도로 대조한다.

## 원격 업데이트 연결

새 설치판을 한 번 설치한 뒤 [UPDATES.md](UPDATES.md)에 따라 PC 연결 코드를 발급하고 GUI의 원격 업데이트 연결에 입력한다. 온도 수집에는 키/로그인을 추가하지 않는다. 새 버전이 표시돼도 웹에서 직접 실행해야 적용한다. 설정·이력·전송 대기는 보존한다.
