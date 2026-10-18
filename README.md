# YouTube Live Dub MVP · v0.6.1

유튜브의 원문 자막 또는 로컬 음성 인식 결과를 한국어로 번역하고, 영상 시간에 맞춰 더빙 음성을 재생하는 Chrome Manifest V3 확장 프로그램입니다. 현재 기본 경로는 **로컬 Gemma 4 E4B 번역 → Supertonic 3 음성 생성(1.15배)**입니다.

**다른 PC에서 처음 설치한다면 [Windows 설치 안내](docs/install-windows.md)를 먼저 따르세요.** Chrome 확장과 같은 PC의 로컬 서버·모델이 모두 필요합니다. 최신 수정본을 GitHub에 반영하는 방법과 전달용 설명은 [GitHub 게시 안내](docs/publish-github.md)에 있습니다. 현재 지원 대상은 YouTube 일반 영상이며, SNS 확장은 프로토타입 단계입니다.

2026-10-18 최신 수정본 배포 브랜치: [codex/dub-supertonic-cloud-sync](https://github.com/Choi-sungjin/youtube-live-dub-mvp/tree/codex/dub-supertonic-cloud-sync). [이 브랜치 소스 ZIP 받기](https://github.com/Choi-sungjin/youtube-live-dub-mvp/archive/refs/heads/codex/dub-supertonic-cloud-sync.zip). `main`에 합쳐지기 전에는 아래처럼 브랜치를 지정해서 받으세요. 저장소가 Private이므로 접근 권한이 있는 GitHub 계정으로 로그인해야 합니다.

```powershell
git clone --branch codex/dub-supertonic-cloud-sync https://github.com/Choi-sungjin/youtube-live-dub-mvp.git
```

## 현재 실행 방법 (Windows)

```powershell
cd "$env:USERPROFILE\youtube-live-dub-mvp"
.\scripts\start-local.ps1
```

브라우저에서 http://127.0.0.1:18789/diagnostics 를 열면 실제 번역과 음성 재생을 먼저 확인할 수 있습니다.

1. 크롬의 `chrome://extensions`에서 기존 확장을 새로고침하거나, 개발자 모드의 압축해제 확장 불러오기로 `extension/` 폴더를 선택합니다.
2. 유튜브 영상을 새로고침합니다. 패널이 숨겨졌다면 확장 아이콘에서 Open을 선택합니다.
3. 패널 버전 **0.6.1**, Backend **http://127.0.0.1:18789**를 확인합니다.
4. 기본 음성 엔진 **Supertonic 3 · 로컬 음성 · 1.15배**에서 **Test**, **Start** 순서로 확인합니다.
5. 자동 서버 시작을 쓰려면 [native host 설치 안내](native-host/README.md)를 참고합니다. 수동 서버 실행 상태에서는 설치 없이 백엔드 연결이 가능합니다.

Supertonic 3는 이 PC의 모델을 한 번 불러온 뒤 계속 재사용합니다. **생성 속도는 1.15배로 고정**하고 WAV 파일에 반영합니다. 유튜브가 1배속일 때 더빙 플레이어도 1배속으로 재생하며, 자막 길이에 맞춘 추가 배속을 적용하지 않습니다. 유튜브 재생 속도를 사용자가 바꾸면 더빙도 영상 속도를 따릅니다. M1–M5, F1–F5 음성을 고를 수 있으며 피치·외부 API 모델 설정은 비활성화됩니다. 현재 로컬 경로의 번역·음성 생성에는 외부 AI API가 필요하지 않습니다.

Ollama가 실행 중이어야 합니다. 이 PC에는 `gemma4:e4b-it-q4_K_M`이 설치되어 있으며 서버 시작 때 미리 불러옵니다. 30분 메모리 유지와 10분 주기 갱신으로 다음 번역을 준비합니다. 새 PC에서는 Ollama 설치와 해당 모델 다운로드를 먼저 완료하세요. 서버가 임의로 모델을 다운로드하거나 외부 번역 API로 대체하지 않습니다.

`backend/.env`의 로컬 설정은 다음과 같습니다. 기존 키가 저장되어 있어도 이 경로에서는 Z.ai/OpenAI를 호출하지 않습니다.

```dotenv
TRANSLATION_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:e4b-it-q4_K_M
TTS_PROVIDER=supertonic3
```

최신 결과는 [24분 영상 후반 재생·SNS 확장 워크플로우](docs/workflows/live-dub-24min-and-sns-2026-10-18.md)에 보관합니다. 5:50부터 끝까지의 재생 범위, v12 문맥·발음 보정, 실제 시작·정지·탐색 지연과 남은 불확실성을 구분했습니다. [SNS 설계 결정서](docs/architecture/ADR-001-cross-platform-local-dubbing.md)의 공통 코어는 아직 사이트별 제품에 연결하지 않은 프로토타입입니다. 기존 [19분 전체 영상 검사](docs/workflows/live-dub-full-video-2026-10-18.md)와 [로컬 Gemma 전환 기록](docs/workflows/live-dub-local-gemma-2026-10-18.md)도 보존합니다. 이미 확장 0.6.1이면 이번 백엔드 v12 변경 때문에 추가 새로고침할 필요는 없습니다.

새 PC에서는 [설치 안내](docs/install-windows.md)의 Python 3.12 가상환경·패키지·세 모델 다운로드·GPU/CPU 설정을 모두 준비하세요. 기존 PC의 전역 Python 패키지에 의존하지 않습니다. 모델은 최초 설정 때 다운로드하고, 서버 실행 중에는 자동 다운로드하지 않습니다.

공식 모델과 사용 조건은 [Supertonic 3 모델 카드](https://huggingface.co/Supertone/supertonic-3)를 참고하세요. Windows 로컬 음성과 Supertone HTTP API도 선택지로 유지됩니다. Supertonic 3는 별도 API 키 없이 로컬에서 음성을 합성합니다.

## 검증 범위

2026-10-17: 실제 유튜브 원본 다운로드, 앞 20초 음성 인식, 한국어 번역, Windows 음성 생성과 크롬 진단 화면 오디오 재생을 확인했습니다. 당시 Supertone HTTP API 요청은 HTTP 404를 반환했습니다.

자세한 실행 결과와 남은 항목은 [검증 기록](docs/verification-2026-10-17/REPORT.md)에 있습니다. 기존 코드는 프로젝트 외부 백업 폴더에 보관했습니다.

2026-10-18: v0.5.2 검사에서 발견한 뒤로 탐색 버퍼 결함을 v0.5.3에서 수정했습니다. 사용자가 선택한 Stefan 3D AI의 새 영상(`2hqcDHnyJaY`)에서 실제 Supertonic 3 한국어 재생, 생성 속도 1.15/플레이어 1.00, 발화 중 일시정지, 앞으로 이동, Stop 후 원음량 복구, 재시작 직후 이전 구간으로 이동해 재생 복구를 확인했습니다. 회귀 검사 14개도 통과했습니다. 처음 보는 영상은 자막 수집·로컬 음성 인식·번역 준비 시간이 필요하며 초기 더빙 공백도 관찰했습니다. 전체 19분 완주 및 청감 품질 검사는 포함하지 않습니다. 결과와 증거는 [Chrome 검사 기록](docs/verification-2026-10-18/REPORT.md)에 있습니다.

## v0.6.0 성능 개선

처음 음성 인식 범위를 35초로 줄이고 지속 실행 작업을 재사용합니다. 번역 결과는 서버를 다시 켜도 파일 캐시에서 재사용하며, 음성은 최대 4문장씩 준비합니다. 현재 위치의 음성이 부족하면 영상을 기다리게 하고, 긴 문장은 1.15배 조건을 유지하면서 끝까지 재생합니다. 기존 Z.ai 구성의 동작과 Chrome 실측은 [이전 워크플로우 자료](docs/workflows/live-dub-v0.6.0-2026-10-18.md)에 남기며, 로컬 Gemma 검증과 구분합니다.

## 개발 검사

Claude 클라우드에서는 `npm run test:cloud`로 API 키 없이 개발 검사를 실행합니다.
환경 설정과 Windows 검증 절차는 [클라우드 개발 안내](docs/claude-cloud.md)를 참고하세요.

```powershell
npm.cmd run check
npm.cmd run test:prepare       # 모의 음성 / 외부 API 호출 없음
npm.cmd run test:regressions   # 회귀 테스트 / 외부 API 호출 없음
```

Z.ai/OpenAI/Supertone API를 별도로 선택한 실검사는 해당 제공자의 사용량을 소모합니다. 기본 로컬 Gemma/Supertonic 경로는 이 PC의 연산 자원을 사용합니다. 검증 스크립트의 `--tts-provider windows-sapi`는 Windows 로컬 음성을 사용합니다. 모의 문장/파형은 명시적인 테스트 모드에서만 사용하며, 실서비스 오류를 가리지 않습니다.

자막 추출용 도구는 `.venv-win`을 우선 사용합니다. 새 PC의 Node 22 이상, FFmpeg, faster-whisper 패키지와 사전 모델 다운로드 절차는 [설치 안내](docs/install-windows.md)에 정리했습니다.

## 구성

- `extension/`: 크롬 확장과 영상 동기화
- `backend/`: 로컬 서버, Supertonic 3 상주 작업 프로세스, 실제 WAV 캐시, 진단 화면
- `native-host/`: 크롬에서 로컬 서버를 시작하는 연결 프로그램
- `lib/`, `api/`: 기존 Vercel 서버 경로 (Supertonic 3 및 Windows 음성은 로컬 백엔드에서만 지원)
- `scripts/`: 음성 인식, 검증, 실행 도구

API 키는 서버의 환경 파일에서 읽고 브라우저에 전달하지 않습니다. GitHub에 코드를 올리는 것과 Vercel 배포는 별개이며, 이 버전은 Vercel에 배포하지 않았습니다.
