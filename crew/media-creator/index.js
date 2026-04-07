export default {
  id: "media-creator",
  name: "Media Creator",

  register(api) {
    // Uses built-in tools: generateImage, generateVideo, generateMusic, imageOps
    // No custom tools needed — all registered in core tool registry
    api.log.info("Media Creator crew registered");
  },
};
