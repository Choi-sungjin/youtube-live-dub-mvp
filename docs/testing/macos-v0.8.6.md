# macOS v0.8.6 검증 · 2026-11-10

Apple Silicon macOS에서 Node 26.10.0, Python 3.12.13으로 실행했습니다.
이 기기의 기존 `gemma4:e4b` 모델을 명시적으로 재사용했습니다. 기본 설치 모델
`gemma4:e4b-it-q4_K_M`의 신규 다운로드 완료 검사는 이번 범위에 포함하지 않습니다.

## 통과

- `YLD_NO_OPEN=1 bash install-macos.command`: 패키지 설치, 기존 설정/모델 재사용,
  Supertonic 실제 합성 및 Whisper small CPU/int8 추론, 서버 실행.
- `bash stop-macos.command`, `YLD_NO_OPEN=1 bash start-macos.command`: 종료·재시작,
  재실행 시 기존 서버 재사용. 공유 Ollama 서비스 유지.
- `npm run test:cloud`: JavaScript 문법/버전 검사, 회귀 검사 127개,
  모의 번역/오디오 계약 검사 통과. 이 자동 검사는 실제 AI API를 호출하지 않습니다.
- 네 Mac 셸 파일 각각 `bash -n` 통과.
- `/api/health`: macOS, v0.8.6, 실제 Gemma·Supertonic·Whisper 준비 완료.
- 선택적 음색 분석 모델 다운로드 및 설치 완료. 실제 화자 정확도 평가는 미실시.
- Chrome 확장 v0.8.6 로드 및 YouTube 패널 Test: 백엔드 연결과 테스트 음성 재생 확인.
- 진단 페이지에서 실제 영어 문장을 한국어로 번역하고 WAV 생성·브라우저 재생 확인.
  첫 시험 응답 약 4.28초, 합성 약 2.16초, 생성 오디오 2.46초(1.15배 설정).
- 명시적인 검사용 합성 영어 음성으로 H.264/AAC MP4를 만들고, 로컬 MP4 API의
  업로드 → Whisper 실제 인식 → Gemma 실제 번역 → Supertonic 실제 합성 → WAV 수신 확인.
  인식된 문장 2개, 한국어 음성 2.60초 및 2.56초. 실제 사용자 영상 품질 벤치마크는 아닙니다.

## 제한 · 미검증

- 공개 YouTube 영상 `NL65Awuv8gU`의 원본 다운로드가 YouTube의
  “Sign in to confirm you’re not a bot” 응답으로 차단됨. 기본 yt-dlp 2026.8.19와
  진단용 2026.10.26 모두 동일했고, 이후 저장소 고정 버전으로 복구했습니다.
  이 영상은 자막도 없어 Start가 오류를 표시했습니다. 실제 YouTube 연속 더빙 재생은 미검증입니다.
- 로그인 쿠키는 가져오지 않았습니다. 로컬 MP4 경로는 위와 같이 별도로 검증했습니다.
- Windows/Linux의 기존 설치 경로를 유지했으며 이번 기기에서 해당 운영체제의 실기기
  설치 검사는 수행하지 않았습니다. 세 운영체제의 모의 자동 검사 CI를 추가했습니다.
- Intel Mac, 새 Mac의 Homebrew 최초 설치, 재부팅 후 자동 시작, 유료 GPT 모드는 미검증입니다.
  로그인 자동 시작 및 Mac Native Messaging은 이 버전 범위에 포함하지 않습니다.

API 키, 로그인 쿠키, 사용자별 설정, 모델, 생성 음성은 저장소에 포함하지 않습니다.
