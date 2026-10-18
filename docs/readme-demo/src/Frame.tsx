import type { ReactNode } from "react";
import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const Frame = ({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: ReactNode;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#101722",
        color: "#f4f7fc",
        fontFamily: '"Malgun Gothic", "Noto Sans KR", sans-serif',
        padding: "34px 48px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 17,
          letterSpacing: 1.5,
          color: "#a4b6ca",
        }}
      >
        <span>LOCAL LIVE DUB / v0.7.0</span>
        <span style={{ color: "#a6efcf", letterSpacing: 0 }}>
          음성 생성 1.15×
        </span>
      </div>
      <Interactive.Div
        name="장면 제목"
        premountFor={fps}
        style={{
          fontSize: 44,
          fontWeight: 700,
          letterSpacing: -2,
          marginTop: 28,
          whiteSpace: "nowrap",
          opacity: interpolate(frame, [0, 0.3 * fps], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        {title}
      </Interactive.Div>
      <div style={{ marginTop: 16, fontSize: 20, color: "#9ab7fa" }}>
        {step}
      </div>
      <div style={{ marginTop: 24 }}>{children}</div>
      <div
        style={{
          position: "absolute",
          bottom: 24,
          left: 48,
          right: 48,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 15,
          color: "#8c9bac",
        }}
      >
        <span>
          사용 흐름 안내 애니메이션 · 실제 화면·대기 시간은 다를 수 있습니다
        </span>
        <span>MP4 + WEB</span>
      </div>
    </AbsoluteFill>
  );
};

export const Button = ({
  label,
  active = false,
}: {
  label: string;
  active?: boolean;
}) => (
  <div
    style={{
      backgroundColor: active ? "#a6efcf" : "#263349",
      color: active ? "#101722" : "#e9effa",
      padding: "13px 20px",
      borderRadius: 10,
      fontSize: 22,
      fontWeight: 700,
      whiteSpace: "nowrap",
    }}
  >
    {label}
  </div>
);
