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
