import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { LogoStinger } from "./components/LogoStinger";

/**
 * Default scaffold scene. Overwrite per-job.
 *
 * RULES (Daemora video pipeline):
 *   - Every animation MUST be driven by useCurrentFrame() — no CSS transitions.
 *   - Use staticFile("name.png") for assets dropped into ./public/.
 *   - Default canvas: 1080x1920 vertical, 30 fps. Override in Root.tsx.
 *   - END EVERY VIDEO with a <LogoStinger /> sequence in the last 2-3s
 *     for the daemora bouncing-then-blinking sign-off.
 */
export const Video: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const stingerLength = Math.round(fps * 2.5); // 2.5s end stinger
  const stingerStart = durationInFrames - stingerLength;

  const introOpacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence from={0} durationInFrames={stingerStart} layout="none">
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div style={{ color: "#00ff88", fontFamily: "monospace", fontSize: 96, opacity: introOpacity }}>
            DAEMORA
          </div>
        </AbsoluteFill>
      </Sequence>

      <Sequence from={stingerStart} durationInFrames={stingerLength} layout="none">
        <LogoStinger />
      </Sequence>
    </AbsoluteFill>
  );
};
