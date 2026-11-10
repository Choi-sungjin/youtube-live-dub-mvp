# v0.9.1 화자 음색 분리 및 재생 오류 수정

## 문제와 변경

v0.9.0의 빠른 원음 경로는 STT에만 오디오를 전달했다. 별도의 화자 판별은 yt-dlp 원음 획득을 시도해 실패하면 기본 음색으로 합성했다. 따라서 자동 음색이 선택되어 있어도 새 경로에서 남녀 음색 구분이 연결되지 않았다.

자동 음색에서는 현재 영상의 버퍼 원음 또는 원본 미디어 수집을 사용한다. 같은 임시 오디오에서 STT와 로컬 화자 분석을 병렬 실행한다. 최대 26초를 750ms 간격으로 검사하고 각 구간에 최대 1.5초 문맥을 사용한다. 확실한 판별은 즉시 음색을 전환한다. 짧은 불확실한 말끝은 최대 1.5초까지 기존 음색을 유지하며, 무음이나 확실한 반대 판별을 덮어쓰지 않는다. 단어 타임스탬프 기준으로 음색이 바뀌는 곳을 분리하고, 자막 정규화·확장·청크 생성에서도 그 경계를 보존한다.

서버가 발급한 구간별 키로 원본 영상·시작·끝 시각에 판별 결과를 연결한다. 클라이언트가 보낸 임의의 남녀 라벨을 믿지 않는다. 결과는 메모리에 최대 2,000개/30분 보관하며 원음은 두 분석이 종료된 뒤 삭제한다. 버퍼/실시간 수집 결과를 합성할 때 별도 다운로드나 같은 구간의 재분석을 하지 않는다. 수동 음색은 선택한 값을 유지한다. 자동 음색에서 버퍼를 읽을 수 없으면 8초 원본 수집 경로를 사용한다.

| 옵션 | 남성 음색 | 여성 음색 |
| --- | --- | --- |
| 1. Gemma → Supertonic | M1 | F1 |
| 2. Gemma → GPT 음성 | cedar | marin |
| 3. GPT 번역 → Supertonic | M1 | F1 |
| 4. GPT 번역 → GPT 음성 | cedar | marin |

## 오류 목록

| 신고 오류 | 수정 | 검증 |
| --- | --- | --- |
| `The play() request was interrupted by a call to pause()` | 중복 play 요청 방지, Pause/Stop/Seek 시 대기 요청 무효화, AbortError와 실제 권한/디코딩 실패 구분. 원본 수집의 재생 요청이 Pause로 중단되면 수집을 실패시키지 않고 재개를 기다림 | 지연된 play 거부·Pause·Stop, 수집 Pause/Resume, 실제 NotAllowedError 표시 회귀 검사 |
| `Invalid capture sender` | SPA 전환 전 sender URL의 영상 ID 대신 동일 documentId의 현재 URL을 읽어 대조. 본 확장·최상위 프레임·HTTPS YouTube 출처 검증 유지. 화면 이동 시작 시 세션 취소, 이동 완료 시 이전 오류 표시 정리 | 이전 URL/현재 URL 불일치 정상 요청 허용, 타 확장·하위 프레임·교체된 문서·다른 영상 요청 거부 검사 |

## 실제 검증

2026-11-10 Mac, 로컬 Whisper base와 audEERING ONNX 모델 사용. Supertonic M1 → F1 → M1 영어 음성 10.84초를 만들어 합친 **합성 테스트 입력**을 실제 `/api/captions/capture`에 전달했다. 원음 인식과 판별 전체 약 2.7초. 다섯 문장의 라벨은 남성/남성/여성/여성/남성이었으며, 이어서 네 모드 모두 실제 번역 및 한국어 WAV 합성을 실행했다. 1/3번 출력은 M1/M1/F1/F1/M1, 2/4번은 cedar/cedar/marin/marin/cedar였다. 원음과 완성 음성, 상세 결과는 로컬 검증 캐시에만 보관했다.

자동 검사 `npm run test:cloud`: 변경 전 150개, 변경 후 160개 통과. 단어 경계 분할·키 전달·결과 만료·잘못된 키의 기본 처리·실제 합성 음색 및 캐시 키 사용·두 오류의 재현 검사를 포함한다. 자동 검사의 모델 응답은 fixture이며 위 실제 모델/API 검증과 별개다.

이것은 개인의 성별 신원을 판정하거나 목소리를 복제하는 기능이 아니다. 들리는 음색에 맞는 합성 음성을 선택한다. 같은 성별의 여러 사람을 각기 다른 고유 음성으로 나누는 완전한 화자 식별은 지원하지 않는다. 짧은 교차 발화, 겹치는 말소리, 음악 및 낮은 신뢰도에서는 불확실하거나 부정확할 수 있다. 합성 입력 테스트는 실제 남녀 대화 전반의 정확도 벤치마크가 아니다. Windows/Linux 실제 실행은 이번에 검증하지 않았다.

## 참고

- [Chrome: 비동기 play와 pause의 경합](https://developer.chrome.com/blog/play-request-was-interrupted)
- [Chrome: 메시지 발신 문서 정보](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)
- [Chrome: documentIds를 통한 특정 문서 실행](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-InjectionTarget)
- [audEERING 모델과 사용 예](https://github.com/audeering/w2v2-age-gender-how-to)
