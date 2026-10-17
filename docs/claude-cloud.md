# Claude 클라우드 개발

이 저장소는 Linux 클라우드에서 코드 수정 및 자동 검사를 수행하고,
Windows PC에서 실제 더빙과 Chrome 연동을 검증하도록 준비했습니다.

## 환경 선택

- 권장 이름: `YouTube Live Dub - Dev`
- 네트워크: 제한됨/Trusted, 기본 패키지 관리자 허용
- 추가 허용 도메인: 기본 개발 검사에는 불필요
- 네트워크 시크릿 및 환경 변수: 기본 개발 검사에는 불필요
- 설정 스크립트: 비워 둡니다. Node.js 기본 도구를 사용하며 npm 의존성이 없습니다.
- 저장소의 SessionStart 훅이 Node 버전과 작업 안내를 출력합니다.

새 클라우드 세션에서 이 저장소와 해당 환경을 선택한 다음 요청합니다.

> CLAUDE.md를 읽고 npm run test:cloud를 실행해줘. 우선 소스 코드는
> 수정하지 말고, 운영체제/Node 버전/커밋과 검사 결과를 한국어로 알려줘.
> 모의 검증과 실제 Windows/Chrome에서 남은 검증을 구분해줘.

## 자동 검사

```sh
npm run test:cloud
```

JavaScript 문법/버전 검사, 회귀 테스트, 모의 번역/WAV 생성
검사를 순서대로 실행합니다. API 키를 빈 값으로 덮어써 로컬 환경 파일의
키를 사용하지 않습니다. 외부 유료 API와 YouTube 다운로드를 사용하지
않으며, native messaging 회귀 테스트는 임시 loopback 서버를 사용합니다.

Supertonic 3 소스가 포함되어 있어도 기본 클라우드 검사는 Python 음성 모델을
실행하지 않습니다. 실제 합성은 Python, `requirements-supertonic.txt`의 패키지,
설치된 모델 파일이 있는 로컬 환경에서 따로 검증합니다.

## Windows에서 최종 확인

1. 변경 브랜치를 검토하고 로컬에 가져옵니다.
2. `scripts/start-local.ps1`로 로컬 백엔드를 시작합니다.
3. Chrome 확장을 새로고침하고 YouTube 페이지도 새로고침합니다.
4. 진단 화면과 확장에서 실제 음성을 확인합니다.
5. Start/Stop, 일시정지, 탐색, 재생 속도 변경, 원래 볼륨 복원을 확인합니다.

클라우드 테스트 성공은 실제 번역 품질, 음성 출력, STT, 브라우저 동기화
성공을 의미하지 않습니다. 테스트가 사용하는 모의 WAV는 실제 한국어
음성 합성 결과가 아닙니다.

## 저장소에서 제외한 파일

실제 `.env*` 파일(`.env.example` 템플릿 제외), `.venv*`, `backend/.cache/`,
`__pycache__/`, `.vercel/`, 로컬 검증 캡처/로그 폴더,
설치 시 생성되는 `native-host/com.youtube_live_dub.backend.json`은 업로드하지
않습니다. 로컬 파일은 보존합니다. 로컬 검증 기록 링크는 클라우드 복제본에
없을 수 있습니다. 새 PC의 native-host manifest는 설치 스크립트가 생성합니다.

공식 안내:
- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/web-quickstart
