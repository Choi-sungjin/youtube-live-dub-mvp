# YouTube Live Dub MVP · v0.5.0

유튜브의 원문 자막 또는 로컬 음성 인식 결과를 한국어로 번역하고, 영상 시간에 맞춰 더빙 음성을 재생하는 Chrome Manifest V3 확장 프로그램입니다.

## 현재 실행 방법 (Windows)

```powershell
cd "$env:USERPROFILE\youtube-live-dub-mvp"
.\scripts\start-local.ps1
```

브라우저에서 http://127.0.0.1:18789/diagnostics 를 열면 실제 번역과 음성 재생을 먼저 확인할 수 있습니다.

1. 크롬의 `chrome://extensions`에서 기존 확장을 새로고침하거나, 개발자 모드의 압축해제 확장 불러오기로 `extension/` 폴더를 선택합니다.
2. 유튜브 영상을 새로고침합니다. 패널이 숨겨졌다면 확장 아이콘에서 Open을 선택합니다.
3. 패널 버전 **0.5.0**, Backend **http://127.0.0.1:18789**를 확인합니다.
4. 음성 엔진 **Windows 로컬 음성**을 선택한 뒤 **Test**, **Start** 순서로 확인합니다.
5. 자동 서버 시작을 쓰려면 [native host 설치 안내](native-host/README.md)를 참고합니다. 수동 서버 실행 상태에서는 설치 없이 백엔드 연결이 가능합니다.

Windows 음성은 설치된 해당 언어의 음성을 사용하며, Supertone과 별개의 선택지입니다. 피치·보이스·Supertone 모델 설정은 Windows 음성 모드에서 비활성화됩니다. 번역 API 사용은 계속 필요합니다.

## 검증 범위

2026-10-17: 실제 유튜브 원본 다운로드, 앞 20초 음성 인식, 한국어 번역, Windows 음성 생성과 크롬 진단 화면 오디오 재생을 확인했습니다. Supertone API는 현재 이 환경의 요청에 HTTP 404를 반환했습니다. 실제 유튜브 확장 재생·탐색 동기화는 사용자 측 확장 반영 후 확인해야 합니다.

자세한 실행 결과와 남은 항목은 [검증 기록](docs/verification-2026-10-17/REPORT.md)에 있습니다. 기존 코드는 프로젝트 외부 백업 폴더에 보관했습니다.

## 개발 검사

Claude 클라우드에서는 `npm run test:cloud`로 API 키 없이 개발 검사를 실행합니다.
환경 설정과 Windows 검증 절차는 [클라우드 개발 안내](docs/claude-cloud.md)를 참고하세요.

```powershell
npm.cmd run check
npm.cmd run test:prepare       # 모의 음성 / 외부 API 호출 없음
npm.cmd run test:regressions   # 회귀 테스트 / 외부 API 호출 없음
```

실제 API 검사는 번역 제공자의 사용량을 소모합니다. 검증 스크립트의 `--tts-provider windows-sapi`는 Windows 로컬 음성을 사용합니다. 모의 문장/파형은 명시적인 테스트 모드에서만 사용하며, 실서비스 오류를 가리지 않습니다.

자막 추출용 도구는 `.venv-win`을 우선 사용합니다. Node 22 이상, FFmpeg, Whisper가 필요합니다. 이 PC에서는 기존 Whisper/FFmpeg를 재사용합니다.

```powershell
python -m venv --system-site-packages .venv-win
.\.venv-win\Scripts\python.exe -m pip install -r requirements-tools.txt
```

## 구성

- `extension/`: 크롬 확장과 영상 동기화
- `backend/`: Windows 로컬 서버, 실제 WAV 캐시, 진단 화면
- `native-host/`: 크롬에서 로컬 서버를 시작하는 연결 프로그램
- `lib/`, `api/`: 기존 Vercel 서버 경로 (Windows 음성 지원 안 함)
- `scripts/`: 음성 인식, 검증, 실행 도구

API 키는 서버의 환경 파일에서 읽고 브라우저에 전달하지 않습니다. 이번 변경은 로컬 파일에만 반영됐으며 Vercel에는 배포하지 않았습니다.
