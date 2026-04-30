import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Daemora logo end-stinger. Two-phase animation:
 *   1. Bounce-in: scale spring from 0 to 1 over the first ~25 frames.
 *   2. Blink:     opacity oscillates between 0.35 and 1.0 four times.
 *
 * Drop into the FINAL ~2-3 seconds of every video as the brand sign-off.
 *
 * Usage in a scene:
 *   <Sequence from={durationInFrames - 60} durationInFrames={60}>
 *     <LogoStinger />
 *   </Sequence>
 *
 * Override placement / size via the optional props.
 */
interface LogoStingerProps {
  /** static filename in ./public/ — defaults to "logo.png" */
  src?: string;
  /** logo width in px — defaults to 360 */
  width?: number;
  /** background tint while logo is on — defaults to a near-black wash */
  background?: string;
}

export const LogoStinger: React.FC<LogoStingerProps> = ({
  src = "logo.png",
  width = 360,
  background = "#0A0A0F",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase 1: bounce-in scale
  const scale = spring({
    frame,
    fps,
    config: { damping: 12, mass: 0.6, stiffness: 140 },
  });

  // Phase 2: blink — kicks in once the bounce has mostly settled (~frame 22).
  // Four pulses over ~45 frames at 30fps (~1.5s).
  const blinkStart = Math.round(fps * 0.75);
  const blinkPeriod = Math.round(fps / 4); // 8 frames per half-cycle at 30fps
  const inBlinkWindow = frame >= blinkStart;
  const blinkOpacity = inBlinkWindow
    ? 0.35 + 0.65 * (Math.cos(((frame - blinkStart) / blinkPeriod) * Math.PI) * 0.5 + 0.5)
    : interpolate(frame, [0, blinkStart], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: background, justifyContent: "center", alignItems: "center" }}>
      <Img
        src={staticFile(src)}
        style={{
          width,
          height: "auto",
          transform: `scale(${scale})`,
          opacity: blinkOpacity,
          filter: "drop-shadow(0 0 24px rgba(34, 211, 238, 0.35))",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 96,
          color: "rgba(255,255,255,0.85)",
          fontFamily: "monospace",
          fontSize: 28,
          letterSpacing: 4,
          opacity: blinkOpacity,
        }}
      >
        @daemora.ai
      </div>
    </AbsoluteFill>
  );
};
