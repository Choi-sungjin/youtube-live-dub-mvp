# YouTube Live Dub MVP · v0.5.2

유튜브의 원문 자막 또는 로컬 음성 인식 결과를 한국어로 번역하고, 영상 시간에 맞춰 더빙 음성을 재생하는 Chrome Manifest V3 확장 프로그램입니다.

## 현재 실행 방법 (Windows)

```powershell
cd "$env:USERPROFILE\youtube-live-dub-mvp"
.\scripts\start-local.ps1
```

브라우저에서 http://127.0.0.1:18789/diagnostics 를 열면 실제 번역과 음성 재생을 먼저 확인할 수 있습니다.

1. 크롬의 `chrome://extensions`에서 기존 확장을 새로고침하거나, 개발자 모드의 압축해제 확장 불러오기로 `extension/` 폴더를 선택합니다.
2. 유튜브 영상을 새로고침합니다. 패널이 숨겨졌다면 확장 아이콘에서 Open을 선택합니다.
3. 패널 버전 **0.5.2**, Backend **http://127.0.0.1:18789**를 확인합니다.
4. 기본 음성 엔진 **Supertonic 3 · 로컬 음성 · 1.15배**에서 **Test**, **Start** 순서로 확인합니다.
5. 자동 서버 시작을 쓰려면 [native host 설치 안내](native-host/README.md)를 참고합니다. 수동 서버 실행 상태에서는 설치 없이 백엔드 연결이 가능합니다.

Supertonic 3는 이 PC의 모델을 한 번 불러온 뒤 계속 재사용합니다. **생성 속도는 1.15배로 고정**하고 WAV 파일에 반영합니다. 유튜브가 1배속일 때 더빙 플레이어도 1배속으로 재생하며, 자막 길이에 맞춘 추가 배속을 적용하지 않습니다. 유튜브 재생 속도를 사용자가 바꾸면 더빙도 영상 속도를 따릅니다. M1–M5, F1–F5 음성을 고를 수 있으며 피치·외부 API 모델 설정은 비활성화됩니다. 번역 API 사용은 계속 필요합니다.

이 PC에는 Supertonic 3 모델과 Python 패키지가 이미 설치되어 있습니다. 새 PC에서는 먼저 Python 3.12 가상환경과 패키지·모델을 준비하세요. 모델은 최초 설정 때 다운로드하고, 서버 실행 중에는 자동 다운로드하지 않습니다.

```powershell
python -m venv --system-site-packages .venv-win
.\.venv-win\Scripts\python.exe -m pip install -r requirements-supertonic.txt
.\.venv-win\Scripts\python.exe -c "from supertonic import TTS; TTS(model='supertonic-3', auto_download=True)"
```

공식 모델과 사용 조건은 [Supertonic 3 모델 카드](https://huggingface.co/Supertone/supertonic-3)를 참고하세요. Windows 로컬 음성과 Supertone HTTP API도 선택지로 유지됩니다. Supertonic 3는 별도 API 키 없이 로컬에서 음성을 합성합니다.

## 검증 범위

2026-10-17: 실제 유튜브 원본 다운로드, 앞 20초 음성 인식, 한국어 번역, Windows 음성 생성과 크롬 진단 화면 오디오 재생을 확인했습니다. 당시 Supertone HTTP API 요청은 HTTP 404를 반환했습니다.

자세한 실행 결과와 남은 항목은 [검증 기록](docs/verification-2026-10-17/REPORT.md)에 있습니다. 기존 코드는 프로젝트 외부 백업 폴더에 보관했습니다.

2026-10-18: v0.5.1에서 실제 Chrome 유튜브의 시작, 영상 일시정지에 따른 더빙 정지, 앞뒤 구간 이동, Stop 후 원음량 복구, 재시작을 확인했습니다. v0.5.2에서는 Supertonic 3의 1.15배 음성 생성과 크롬 진단 화면의 실제 재생을 확인했습니다. 새 엔진을 사용하는 유튜브 확장의 최종 검사는 확장 새로고침 후 진행합니다. 결과와 증거는 [Chrome 검사 기록](docs/verification-2026-10-18/REPORT.md)에 있습니다.

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
- `backend/`: 로컬 서버, Supertonic 3 상주 작업 프로세스, 실제 WAV 캐시, 진단 화면
- `native-host/`: 크롬에서 로컬 서버를 시작하는 연결 프로그램
- `lib/`, `api/`: 기존 Vercel 서버 경로 (Supertonic 3 및 Windows 음성은 로컬 백엔드에서만 지원)
- `scripts/`: 음성 인식, 검증, 실행 도구

API 키는 서버의 환경 파일에서 읽고 브라우저에 전달하지 않습니다. GitHub에 코드를 올리는 것과 Vercel 배포는 별개이며, 이 버전은 Vercel에 배포하지 않았습니다.
