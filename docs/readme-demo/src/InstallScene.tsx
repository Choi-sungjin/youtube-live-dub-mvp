import { Frame } from "./Frame";

export const InstallScene = () => (
  <Frame
    step="04 / Windows 10·11 x64 · 전체 ZIP 압축 해제"
    title="다른 PC도, 설치 파일 한 번으로"
  >
    <div
      style={{
        padding: "27px 30px",
        borderRadius: 18,
        backgroundColor: "#1b2636",
        border: "2px solid #a6efcf",
      }}
    >
      <div style={{ fontSize: 22, color: "#afbed1" }}>처음 설치</div>
      <div
        style={{
          fontFamily: "Consolas,monospace",
          fontSize: 42,
          color: "#a6efcf",
          marginTop: 8,
        }}
      >
        install-windows.cmd
      </div>
      <div style={{ fontSize: 23, marginTop: 20 }}>
        GPU / CPU 자동 선택 · 모델 다운로드 · 서버 실행
      </div>
    </div>
    <div style={{ fontSize: 24, marginTop: 23, color: "#afbed1" }}>
      다음 실행{" "}
      <span
        style={{
          fontFamily: "Consolas,monospace",
          color: "#f4f7fc",
          marginLeft: 18,
        }}
      >
        start-player.cmd
      </span>
    </div>
    <div style={{ fontSize: 19, marginTop: 14, color: "#8c9bac" }}>
      웹페이지 영상 찾기는 Chrome에 extension 폴더 등록 후 사용
    </div>
  </Frame>
);
