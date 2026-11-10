# macOS · MacBook 설치

Windows, Linux, Mac은 같은 Chrome 확장과 서버 코드를 사용합니다. Mac에서는
`install-macos.command`, `start-macos.command`, `stop-macos.command`를 사용합니다.
Apple Silicon Mac에서 검증하며, Intel Mac은 아직 실기기 검증 전입니다.

## 처음 설치

1. [Homebrew](https://brew.sh)를 설치합니다. 이미 있다면 건너뜁니다.
2. 저장소를 복제하거나 최신 ZIP을 내려받아 압축을 풉니다.
3. `install-macos.command`를 실행합니다. Finder에서 실행되지 않으면 터미널에서 다음 명령을 사용합니다.

```bash
cd youtube-live-dub-mvp
bash install-macos.command
```

설치기는 없는 Node, Python 3.12, FFmpeg, Ollama를 Homebrew로 설치합니다.
Node는 22 이상이 필요합니다. 프로젝트의 `.venv`에 Python 패키지를 격리하며,
Gemma 4 E4B, Supertonic 3, Whisper small을 다운로드합니다. 첫 설치에는 수 GB의
여유 공간과 다운로드 시간이 필요합니다. 음성 인식은 CPU/int8을 사용하고,
Ollama의 번역 가속은 해당 Mac의 Ollama 설치 환경을 따릅니다. CUDA는 설치하지 않습니다.

이미 설치한 다른 Ollama 모델을 사용하려면 첫 설치 때 명시적으로 선택합니다.

```bash
OLLAMA_MODEL=gemma4:e4b bash install-macos.command
```

기본값은 Windows/Linux와 같은 `gemma4:e4b-it-q4_K_M`입니다. 기존 `backend/.env`의
값과 API 키는 보존합니다. `.env.local` 및 프로세스 환경변수가 우선하므로 기존
설정에서 다른 제공자를 선택했다면 그 설정이 계속 적용됩니다. 모델을 바꾸려면
해당 설정 파일의 `OLLAMA_MODEL`을 수정하고 서버를 다시 시작하세요.

4. Chrome에서 `chrome://extensions`를 열고 **개발자 모드 → 압축해제된 확장 프로그램 로드**로
   이 저장소의 `extension` 폴더를 선택합니다.
5. YouTube 페이지를 새로고침하고 확장 아이콘을 누릅니다. **1. 모두 로컬**을 선택하고
   **설정 → Test**, **Start** 순서로 확인합니다.

## 다음 실행 · 종료

- 시작: `start-macos.command` 더블클릭. 서버가 백그라운드에서 실행되고 진단 페이지가 열립니다.
- 종료: `stop-macos.command` 더블클릭. 이 설치의 더빙 서버만 종료하며 공유 Ollama는 유지합니다.
- 진단: <http://127.0.0.1:18789/diagnostics>
- MP4 플레이어: <http://127.0.0.1:18789/player>
- 로그: `backend/.cache/local.log`, 필요시 `backend/.cache/ollama.log`.

로그인 시 자동 실행은 등록하지 않습니다. 재부팅 후에는 시작 파일을 실행하세요.
Windows 전용 Native Messaging 설치기는 Mac에 적용하지 않습니다. Mac에서는 시작
파일로 서버를 먼저 켭니다. 같은 서버가 이미 실행 중이면 중복 실행하지 않으며,
다른 설치나 구버전이 포트를 사용하면 해당 서버를 먼저 종료하라는 오류를 표시합니다.
설치 경로를 옮긴 경우 Python 가상환경을 다시 만들고 Chrome 확장을 다시 등록하세요.

## 자동 음색 선택 (선택)

기본 설치는 M1 음성을 사용할 수 있습니다. 원본 음색에 따른 M1/F1 자동 선택에는
약 333 MB의 별도 모델이 필요합니다. 모델은 **CC BY-NC-SA 4.0**이며 개인·비상업용
사용 조건과 한계는 [음색 선택 안내](speaker-voices.md)를 확인하세요.

```bash
.venv/bin/python scripts/setup-speaker-model.py
# 설치부터 포함할 경우:
YLD_INSTALL_SPEAKER=1 bash install-macos.command
```

GPT 번역/음성은 선택 사항이며 API 키와 사용료가 필요합니다.
`python3 scripts/set-openai-key.py`로 키를 설정한 뒤 서버를 재시작하세요.
로컬 모드에는 외부 AI API 키가 필요 없습니다.

## YouTube 원본 다운로드 제한

자막이 없으면 로컬 음성 인식을 위해 yt-dlp로 원본 음성을 확보합니다. YouTube가
로그인·봇 확인을 요구하는 영상이나 네트워크에서는 이 단계가 실패할 수 있습니다.
서버의 Test 성공만으로 모든 YouTube 영상의 더빙을 보장하지 않습니다. 설치기는
브라우저 쿠키를 자동으로 읽거나 복사하지 않습니다. 이런 경우 직접 보유한 MP4를
로컬 플레이어에서 열어 사용할 수 있습니다.

현재 Mac 검증 범위는 [v0.8.6 검사 기록](testing/macos-v0.8.6.md)을 참고하세요.

## 업데이트

```bash
bash stop-macos.command
git pull --ff-only
bash install-macos.command
```

Chrome 확장 관리 화면에서 확장을 새로고침한 뒤 YouTube도 새로고침합니다.
Windows 사용자는 [Windows 안내](auto-install-windows.md), Ubuntu 사용자는
[Linux 안내](install-linux.md)를 참고하세요.
