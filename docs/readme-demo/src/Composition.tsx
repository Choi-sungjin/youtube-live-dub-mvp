import { Composition, Series, useVideoConfig } from "remotion";
import { ImportScene } from "./ImportScene";
import { ProcessScene } from "./ProcessScene";
import { PlaybackScene } from "./PlaybackScene";
import { InstallScene } from "./InstallScene";

const ReadmeDemo = () => {
  const { fps } = useVideoConfig();
  return (
    <Series>
      <Series.Sequence
        name="파일 또는 URL"
        durationInFrames={4 * fps}
        premountFor={fps}
      >
        <ImportScene />
      </Series.Sequence>
      <Series.Sequence
        name="로컬 모델"
        durationInFrames={4 * fps}
        premountFor={fps}
      >
        <ProcessScene />
      </Series.Sequence>
      <Series.Sequence
        name="재생 조작"
        durationInFrames={5 * fps}
        premountFor={fps}
      >
        <PlaybackScene />
      </Series.Sequence>
      <Series.Sequence
        name="자동 설치"
        durationInFrames={4 * fps}
        premountFor={fps}
      >
        <InstallScene />
      </Series.Sequence>
    </Series>
  );
};

export const MyComposition = () => (
  <>
    <Composition
      id="ReadmeDemo"
      component={ReadmeDemo}
      durationInFrames={204}
      fps={12}
      width={960}
      height={600}
    />
    <Composition
      id="ImportScene"
      component={ImportScene}
      durationInFrames={48}
      fps={12}
      width={960}
      height={600}
    />
    <Composition
      id="ProcessScene"
      component={ProcessScene}
      durationInFrames={48}
      fps={12}
      width={960}
      height={600}
    />
    <Composition
      id="PlaybackScene"
      component={PlaybackScene}
      durationInFrames={60}
      fps={12}
      width={960}
      height={600}
    />
    <Composition
      id="InstallScene"
      component={InstallScene}
      durationInFrames={48}
      fps={12}
      width={960}
      height={600}
    />
  </>
);
