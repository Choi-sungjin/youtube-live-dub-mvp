# README GIF 제작

Remotion 4.0.536 / React 19로 제작한 Local Live Dub v0.7.0 사용 흐름 안내다. 실제 앱 녹화나 성능 측정 영상이 아니다. 실제 브라우저 검사는 [워크플로우](../workflows/mp4-web-v0.7.0.md)에 따로 기록한다.

- 출력: [local-live-dub-v0.7.0.gif](../assets/local-live-dub-v0.7.0.gif)
- 960×600, 12 fps, 204프레임, 17초, 무음·무한 반복
- 4초 입력 선택 → 4초 로컬 모델 → 5초 재생 조작 → 4초 자동 설치
- 외부 영상·음원·사용자 파일 없이 React 도형과 글자로 제작
- Windows의 Malgun Gothic 사용. 다른 OS에서 재생성할 경우 Noto Sans KR 등 한글 폰트를 먼저 설치한다.

이 폴더의 개발 의존성은 GIF 제작에만 사용한다. 일반 설치자는 npm 명령을 실행할 필요가 없으며, 자동 설치기는 이 폴더를 설치하지 않는다.

프로젝트 루트에서:

```powershell
cd docs/readme-demo
npm ci
npm run dev
```

Studio에서 `ReadmeDemo`를 연다. 네 장면은 각각 별도 composition으로도 편집할 수 있다.

```powershell
npm run lint
npm run render:gif
```

렌더는 Remotion CLI의 GIF 출력을 사용한다. 첫 실행 시 Chrome Headless Shell을 다운로드할 수 있다. 렌더 결과는 `docs/assets/`에 저장하며 node_modules, 브라우저 캐시, 임시 프레임은 Git에 포함하지 않는다.

검사: ESLint·TypeScript 통과, Remotion 전체 204프레임 렌더 성공, FFprobe로 GIF 크기·프레임 수·17초 길이 확인. 네 장면의 디코딩 프레임을 열어 한글, 버튼, 텍스트 잘림과 배치를 확인했다.

공식 문서: [Remotion CLI 렌더](https://www.remotion.dev/docs/cli/render), [라이선스](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
