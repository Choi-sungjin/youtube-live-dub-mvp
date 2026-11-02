# v0.8.0 Ubuntu 검증 (2026-11-02)

실제 YouTube `T-HZHO_PQPY`의 짧은 구간으로 검사했다. 전체 영상 완주 검사는 아니다.

| 모드 | 실제 번역 / 음성 | Chrome Test | 연속 재생 진단 |
|---|---|---|---|
| local | Gemma 4 / Supertonic 3 | backend ok | 8클립 |
| gemma-gpt | Gemma 4 / GPT Realtime | backend ok | 15클립 |
| gpt-local | GPT / Supertonic 3 | backend ok | 6클립 |
| gpt | GPT / GPT Realtime | backend ok | 15클립 |

모드별 실행:

```bash
node scripts/verify-live-dub-e2e.js --mode local --max-duration 35 --prepare-segments 2 --force false
node scripts/verify-live-dub-e2e.js --mode gemma-gpt --max-duration 35 --prepare-segments 2 --force false
node scripts/verify-live-dub-e2e.js --mode gpt-local --max-duration 35 --prepare-segments 2 --force false
node scripts/verify-live-dub-e2e.js --mode gpt --max-duration 35 --prepare-segments 2 --force false
```

네 명령 모두 `ok: true`. 제공자 조합 일치, 번역 텍스트, 실제 WAV 다운로드와 길이를 확인했다. Whisper 재인식으로 네 조합의 커피 두 잔 문장 내용을 대조했다. 매우 짧은 로컬 음성 '자, 시작.'은 재인식에서 '자!'로만 잡혔다. 이 결과가 전체 청감 품질을 보증하지는 않는다. Chrome 스피커 출력에서도 백엔드 테스트 한국어 문장이 인식됐다.

YouTube 되감기, 영상·음성 일시정지, 모드 전환 때 이전 재생 종료, Stop 후 원래 음소거 복원, 페이지 새로고침 뒤 모드 유지 확인. 음성이 준비되지 않으면 영상이 기다리는 구간이 있으며 긴 문장은 끝까지 읽은 뒤 이어진다.

```text
npm run test:cloud
ℹ tests 76
ℹ pass 76
ℹ fail 0
PASS: cloud development checks.

env -u PYTHONPATH .venv/bin/pip check
No broken requirements found.
```

격리된 UI 검사: 1366×1000 다크 / 390×844 라이트, 네 선택지·저장값·방향키·Tab·포커스 확인. axe WCAG A/AA 위반 0, 콘솔 예외 0. 별도 코드 검토에서 문맥 전달·캐시 구분 문제를 수정하고 재검토했다.

GPU: RTX 5060 Laptop, Gemma 4 E4B Q4_K_M, 컨텍스트 4096. 새 문장 'The blue robot moves forward and stops at the door.'를 캐시 없이 처리한 실측: 번역 631ms + Supertonic 음성 969ms = 총 1605ms. 초기 모델 적재 시간은 제외하며 다른 문장·환경의 속도를 보증하지 않는다.

로그인 자동 시작 서비스 구성은 확인했으나 실제 재부팅·로그인은 시험하지 않았다. Windows 설치 코드는 정적·회귀 검사 범위이고 Windows 실기 설치는 미검증이다. 유튜브 모든 영상·목소리·언어는 미검증이다. API 키는 서버 환경 파일에만 저장하며 버전 관리에서 제외한다.

아이콘: 선택된 8번 시안을 16/32/48/128픽셀 RGBA PNG로 등록했다. 각 PNG 디코딩, 크기, 투명도, manifest와 action 경로 일치 검사 통과. 최종 `npm run test:cloud`는 76/76 통과했다.


## v0.8.1 페이지 연결 수정 검증

사용자가 전달한 오류: `Unsafe attempt to load URL chrome-extension://…/page-probe.js … Domains, protocols and ports must match.`

변경:
- DOM의 외부 script 주소 삽입을 제거하고 `chrome.scripting.executeScript`의 `MAIN` 실행을 사용한다.
- 요청한 YouTube 최상위 문서 ID로 실행 대상을 고정한다. 다른 출처·하위 프레임·문서 ID 없는 요청·잘못된 모드는 거부한다. Chrome 106 이상, 권한 추가 없음.
- 응답의 source/requestId가 자막 결과에 의해 덮이지 않게 한다.
- 연결 실패 시 대체 자막 경로로 넘기고 재생 진단에 이유를 표시한다.

실행한 검사:

```text
npm run test:cloud
ℹ tests 81
ℹ pass 81
ℹ fail 0
PASS: cloud development checks.

node work/ui-check/probe-check.mjs
exit 0
actualExtension: true
browser: 156.0.8078.4
strictCsp: true
trustedTypesRequired: true
errors: []
```

실제 확장을 별도 Chromium에 로드하고 네 페이지 연결 요청(설치, 스냅샷, 자막 요청, 자막 활성화)의 응답 식별자를 확인했다. 테스트 페이지는 자막 요청에 설정 없음 응답, 자막 활성화에 캐시된 2개 문장을 반환한다. `page-probe.js`에 대한 페이지 URL 요청이 발생하지 않았다. 이 테스트는 실제 유튜브 서버 자막 수집이나 네 음성 제공자 재검증을 뜻하지 않는다.

별도 읽기 전용 코드 검토: 최종 PASS, 지적 없음. 초기 검토에서 문서 ID 없이 프레임에 실행하는 경계 문제를 발견하여 제거한 뒤 재검토했다.

실행 중인 사용자 Chrome에서도 v0.8.1을 확인했다. `T-HZHO_PQPY`에서 페이지 연결 성공, 자막 79개/73개 묶음 확보, Gemma 4 + Supertonic 3 더빙 5클립 재생을 확인했다. 영상 약 24초 지점까지 진행했다. Stop 이후 더빙 종료 및 원래 음소거/음량 복원 확인. 영상은 일시정지 상태로 남겼다.

`youtube-live-dub.service` 재시작 후 `/api/health` → `ok: true`, `version: 0.8.1`. 다시 Chrome의 Test 버튼을 실행하여 `backend ok`와 테스트 음성 완료 확인. 수집한 탭의 warn/error 로그는 `[]`이며, 보고된 페이지 스크립트 주소 오류는 이 시험에서 재발하지 않았다.

첫 더빙 표시 29.82초에는 테스트 중 사용자가 멈춘 상태의 영상에서 재생 버튼을 누르기 전 대기 시간이 포함된다. 순수 처리 지연 측정값으로 해석하지 않는다. 네 음성 조합의 실제 재생은 앞선 v0.8.0 검증 결과이며 이번 수정 후 재생 재검사는 local 조합으로 진행했다. 전체 영상 완주 검사는 아니다.
기존 확장 오류 기록의 삭제 여부는 확인하지 못했다.


## 동일 오류 재신고 후 추가 검토

- 사용자 오류 기록 삭제 이후 YouTube 탭을 새로 불러왔다. 표시된 페이지 버전은 0.8.1이다.
- 그 뒤 사용자가 다른 영상으로 이동해 GPT 번역/GPT 음성을 실행한 상태를 읽기 전용으로 관찰했다. 페이지 연결됨, GPT 음성 엔진 gpt-realtime-2.1-mini, 재생 클립 6개, 영상 114.05초를 확인했다. 이때 수집된 탭 warn/error 로그는 빈 배열이었다.
- Chrome 내부 오류 목록은 도구 접근 제한으로 직접 열지 않았다. 이전 오류의 실제 발생 시각이나 기록 삭제 이후 오류 목록이 빈 상태인지는 독립적으로 확인하지 못했다. 따라서 기존 기록이었다고 단정하지 않는다. 관찰한 새 탭 실행에서는 동일 오류가 재발하지 않았다.

추가 수정:
- popup.html과 popup.js의 고정된 0.7.0 표기를 제거하고 설치 manifest 버전을 표시한다.
- 페이지 응답 버전을 설치 버전과 비교한다. 불일치/누락은 정상으로 표시하지 않고 F5 안내를 보여준다.
- 수신기 없음/확장 컨텍스트 무효화/메시지 연결 종료가 지속되면 1회 재주입 후 중단하고 F5 복구 방법을 표시한다. 강제 새로고침이나 기존 재생 중단은 추가하지 않았다.
- 콘텐츠/음성 엔진 코드는 변경하지 않았다. 버전 번호는 0.8.1 유지.

검증:
```text
npm run test:cloud
ℹ tests 86
ℹ pass 86
ℹ fail 0

node work/ui-check/popup-check.mjs
exit 0
current / stale / disconnected 화면 기대 문구 일치
page errors: [] (각 화면)
```

별도 읽기 전용 재검토: PASS, 지적 없음. 팝업 화면 검사는 별도 테스트 브라우저에서 이루어졌으며 사용자 Chrome의 실제 팝업을 열어 검사한 것은 아니다. 실제 YouTube 실행 확인과 팝업 모의 화면 검증을 구분한다.
