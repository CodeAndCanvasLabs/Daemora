import { Composition } from "remotion";
import { Video } from "./Video.js";

/**
 * Default 30-second 1080x1920 vertical (TikTok / Shorts) composition.
 * Override props (durationInFrames, width, height, fps) by editing this
 * file or by passing --props at render time.
 */
export const Root: React.FC = () => {
  return (
    <Composition
      id="Video"
      component={Video}
      durationInFrames={30 * 30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{}}
    />
  );
};
