export default {
  id: "video-editor",
  name: "Video Editor (Remotion)",

  register(api) {
    // Uses built-in tools + Remotion skill. No custom tools needed.
    // Agent reads SKILL.md → rules/*.md → writes React components → renders via CLI.
    api.log.info("Video Editor crew registered (Remotion)");
  },
};
