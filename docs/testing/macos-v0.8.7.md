# macOS v0.8.7 · 쿠키 없는 YouTube 원음 더빙

검증 날짜: 2026-11-10. Apple Silicon macOS, 기존 Chrome 유튜브 탭, 로컬 Ollama `gemma4:e4b`, faster-whisper small CPU/int8, Supertonic 3.

## 변경

자막을 가져올 수 없는 일반 YouTube 영상은 `<video>.captureStream()`의 오디오 트랙만 최대 25초씩 MediaRecorder로 받아 로컬 STT에 전달한다. 원음 준비 중 음소거하고, 해당 위치로 돌아와 번역·음성을 준비한 다음 기존 패널에서 재생한다. 탭 전체 캡처, 마이크, 새 탭, 추가 권한은 사용하지 않는다.

- 원음 업로드는 loopback 백엔드만 허용하며 크기·구간·WebM 헤더를 검증한다. 처리 후 임시 원음을 삭제한다.
- Stop, 탐색, 오류, 세션 변경을 처리하며 늦은 STT 결과는 버린다.
- 직접 수행하는 자막 요청은 `credentials: omit`; SAPISID 쿠키 읽기/인증 생성 코드를 제거했다. yt-dlp는 사용자 전역 설정을 읽지 않도록 `--ignore-config`를 사용한다.
- Mac 시작기는 기본적으로 서버만 시작한다. 진단 페이지 열기는 `YLD_OPEN_DIAGNOSTICS=1`일 때만 수행한다.

## 실제 검증

대상: [Boston Dynamics · Atlas on a Roll](https://www.youtube.com/watch?v=NL65Awuv8gU).

1. 동일 영상의 yt-dlp 익명 요청은 봇 확인 오류로 실패했다. 추가 클라이언트와 공식 위키에 안내된 PO token provider 실험도 이 환경에서는 실패했다. 실험용 Python provider는 제거했고 제품 의존성에 추가하지 않았다.
2. 기존 유튜브 탭의 Start에서 쿠키 추출/전달 없이 실제 원음을 캡처하고 STT → Gemma 번역 → Supertonic 한국어 음성을 생성했다.
3. v0.8.7에서 50초 위치로 이동해 시작했다. 첫 더빙은 41.84초 후 재생. 영상 60.95초 / 더빙 2.17초·2.72초, 양쪽 모두 재생 중임을 확인했다.
4. 실제 인식: “The point was pushing the actuation to its limits.” 실제 번역: “핵심은 구동을 한계까지 밀어붙이는 거였죠.”
5. 일시정지 시 영상 69.49초와 더빙 3.38초에서 함께 정지했고, 유튜브 재생 버튼으로 재개했다.
6. 원음 준비 중 Stop: 준비 시작 위치로 복귀, 원본 음량 100%, 음소거 해제, 속도 1배, 더빙 없음으로 복구했다.

7. 두 번째 원음 구간까지 자동으로 이어져 영상 97.14초에서 누적 13개 클립 재생을 확인했다.

## 자동 검증

`npm run test:cloud`: 회귀 테스트 134개 통과, 문법/버전 일치 통과, mock 번역/WAV 계약 통과. 추가 검증은 원음 크기/구간 제한, 웹 출처 거부, 실제 타임스탬프 오프셋, 무음 커버리지, 임시 파일 정리, 중지/탐색 복구, 오래된 세션 결과 무시, 쿠키 접근 금지를 포함한다. Mock 테스트 결과를 실제 유튜브 재생 증거로 사용하지 않았다.

## 사용상 한계

25초 원음 준비와 로컬 처리 대기가 구간마다 필요하다. 지연 없는 라이브 스트리밍 방식이 아니며, 준비 중에는 영상을 음소거 상태로 진행했다가 돌아온다. DRM·광고·라이브·캡처 제한 영상은 지원하지 않는다. 준비 중 탐색하면 취소되며 새 위치에서 Start로 다시 시작한다. Chrome의 기존 영상 재생 세션은 그대로 사용하지만 로그인 쿠키를 코드가 읽거나 다운로드 도구로 옮기지 않는다. 자동 음색 분석은 별도의 원본 다운로드가 막히면 기본 음색을 사용한다.

Windows/Linux는 동일 코드 경로 및 기존 CI 대상이며 실제 기기 브라우저 재생 검증은 하지 않았다.

## 참고

- [MDN: HTMLMediaElement.captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/captureStream)
- [yt-dlp 공식 PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
