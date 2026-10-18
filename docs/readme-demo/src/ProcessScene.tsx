import { useCurrentFrame, useVideoConfig } from "remotion";
import { Frame } from "./Frame";

const ModelCard = ({
  name,
  task,
  active,
}: {
  name: string;
  task: string;
  active: boolean;
}) => (
  <div
    style={{
      width: 264,
      height: 208,
      boxSizing: "border-box",
      padding: "30px 18px",
      borderRadius: 18,
      backgroundColor: active ? "#203d38" : "#1b2636",
      border: active ? "2px solid #a6efcf" : "2px solid #334158",
      textAlign: "center",
    }}
  >
    <div style={{ fontSize: 28, fontWeight: 700, whiteSpace: "nowrap" }}>
      {name}
    </div>
    <div
      style={{
        fontSize: 24,
        color: active ? "#a6efcf" : "#afbed1",
        marginTop: 24,
      }}
    >
      {task}
    </div>
    <div style={{ fontSize: 20, color: "#8c9bac", marginTop: 18 }}>
      {active ? "● 처리 단계" : "로컬 모델"}
    </div>
  </div>
);

export const ProcessScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Frame
      step="02 / 원음 → 간결한 한국어 → 더빙"
      title="내 PC에서 한국어 음성으로"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ModelCard
          name="Whisper"
          task="원음 음성 인식"
          active={frame < 1.3 * fps}
        />
        <span style={{ fontSize: 25, color: "#8c9bac" }}>›</span>
        <ModelCard
          name="Gemma 4 E4B"
          task="의미를 살린 번역"
          active={frame >= 1.3 * fps && frame < 2.6 * fps}
        />
        <span style={{ fontSize: 25, color: "#8c9bac" }}>›</span>
        <ModelCard
          name="Supertonic 3"
          task="1.15배 음성 생성"
          active={frame >= 2.6 * fps}
        />
      </div>
      <div style={{ fontSize: 26, color: "#a6efcf", marginTop: 34 }}>
        다음 구간 미리 준비 · 부족하면 영상 대기
      </div>
    </Frame>
  );
};
