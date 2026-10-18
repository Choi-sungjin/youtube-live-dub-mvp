import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Frame, Button } from "./Frame";

export const ImportScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Frame
      step="01 / 파일 또는 공개 주소 선택"
      title="MP4 · 웹영상, 하나의 플레이어"
    >
      <div style={{ display: "flex", gap: 20 }}>
        <div
          style={{
            width: 422,
            height: 225,
            padding: 28,
            boxSizing: "border-box",
            borderRadius: 18,
            backgroundColor: "#1b2636",
            border: frame < 2 * fps ? "2px solid #a6efcf" : "2px solid #334158",
          }}
        >
          <div style={{ fontSize: 36, fontWeight: 700, marginBottom: 14 }}>
            내 MP4 파일
          </div>
          <div style={{ fontSize: 22, color: "#afbed1", marginBottom: 26 }}>
            컴퓨터에서 영상 선택
          </div>
          <Button label="MP4 파일 선택" active={frame < 2 * fps} />
        </div>
        <div
          style={{
            width: 422,
            height: 225,
            padding: 28,
            boxSizing: "border-box",
            borderRadius: 18,
            backgroundColor: "#1b2636",
            border:
              frame >= 2 * fps ? "2px solid #a6efcf" : "2px solid #334158",
          }}
        >
          <div style={{ fontSize: 36, fontWeight: 700, marginBottom: 14 }}>
            공개 웹영상
          </div>
          <div style={{ fontSize: 22, color: "#afbed1", marginBottom: 26 }}>
            HTTPS MP4 / 영상 페이지
          </div>
          <Button label="웹영상 열기" active={frame >= 2 * fps} />
        </div>
      </div>
      <div
        style={{
          height: 4,
          backgroundColor: "#a6efcf",
          marginTop: 22,
          width: interpolate(frame, [0, 4 * fps], [0, 864], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <div style={{ fontSize: 21, color: "#afbed1", marginTop: 18 }}>
        최대 512 MB · 30분 / 로그인·DRM·HLS·blob 제외
      </div>
    </Frame>
  );
};
