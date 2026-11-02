# Ubuntu 로컬 실행

Node 20 이상, Python 3.12, FFmpeg, Ollama가 설치된 환경에서 실행합니다.

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements-tools.txt -r requirements-supertonic.txt -r requirements-stt-fast.txt
ollama pull gemma4:e4b-it-q4_K_M
.venv/bin/python scripts/setup-models.py supertonic
.venv/bin/python scripts/setup-models.py stt --device cpu
```

`backend/.env`를 다음과 같이 만듭니다. 기존 파일에 키가 있으면 덮어쓰지 말고 해당 설정만 변경하세요.

```dotenv
TRANSLATION_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:e4b-it-q4_K_M
TTS_PROVIDER=supertonic3
YLD_STT_MODEL=small
YLD_STT_DEVICE=cpu
YLD_STT_COMPUTE=int8
HOST=127.0.0.1
PORT=18789
```

```bash
PATH="$PWD/.venv/bin:$PATH" node backend/server.js
```

Chrome 개발자 모드에서 `extension` 폴더를 등록하고 YouTube를 새로고침합니다. 기존 확장은 업데이트 후 확장 관리 화면에서 새로고침합니다. 패널의 설정에서 모드를 선택한 다음 Test, Start를 순서대로 누릅니다.

GPT를 사용할 때 `python3 scripts/set-openai-key.py`로 키를 숨김 입력하고 서버를 재시작합니다. 키를 채팅·이슈·커밋에 넣지 않습니다.

이 PC에 `youtube-live-dub.service`가 설치되어 있다면 `systemctl --user restart youtube-live-dub.service`로 재시작하고 `systemctl --user status youtube-live-dub.service`로 상태를 확인할 수 있습니다. 수동 서버와 서비스를 동시에 실행하지 마세요.

GPU 전용 Ollama를 별도로 실행하는 설치에서는 `OLLAMA_BASE_URL`을 해당 주소로 지정합니다. 이 PC의 더빙 전용 서비스 `youtube-dub-ollama.service`는 `127.0.0.1:11435`를 사용합니다. 기존 Ollama 서비스와 별도로 실행하며 모델 파일은 공유합니다. 로그인 시 두 서비스가 시작되도록 설정할 수 있습니다.
