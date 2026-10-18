import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Frame, Button } from "./Frame";

export const PlaybackScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = frame / fps;
  const status =
    second < 1
      ? "더빙 재생"
      : second < 2
        ? "일시정지"
        : second < 3
          ? "35초로 이동"
          : second < 4
            ? "12초로 이동"
            : "더빙 정지 · 원음량 복구";
  const progress = interpolate(
    frame,
    [0, fps, 2 * fps, 2.3 * fps, 3 * fps, 3.3 * fps, 4 * fps, 5 * fps],
    [0.2, 0.24, 0.24, 0.67, 0.67, 0.23, 0.23, 0.23],
    { extrapolateRight: "clamp" },
  );
  return (
    <Frame
      step="03 / 시작 · 정지 · 앞뒤 탐색"
      title="듣고, 멈추고, 원하는 구간으로"
    >
      <div
        style={{
          padding: "20px 28px",
          borderRadius: 18,
          backgroundColor: "#1b2636",
          border: "1px solid #334158",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 22,
            color: "#a6efcf",
          }}
        >
          <span>{status}</span>
          <span style={{ color: "#8c9bac" }}>예시 영상</span>
        </div>
        <div style={{ fontSize: 22, color: "#afbed1", marginTop: 18 }}>
          Why did you come here?
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, marginTop: 8 }}>
          여기 왜 오셨나요?
        </div>
        <div
          style={{
            height: 8,
            borderRadius: 4,
            backgroundColor: "#334158",
            marginTop: 26,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress * 100}%`,
              backgroundColor: "#a6efcf",
            }}
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <Button label="시작 / 재개" active={second < 1} />
        <Button label="일시정지" active={second >= 1 && second < 2} />
        <Button label="구간 이동" active={second >= 2 && second < 4} />
        <Button label="더빙 정지" active={second >= 4} />
      </div>
    </Frame>
  );
};
