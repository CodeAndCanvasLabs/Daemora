import { philipsHue } from "./tools/philipsHue.js";
import { sonos } from "./tools/sonos.js";

export default {
  id: "smart-home",
  name: "Smart Home",

  register(api) {
    api.registerTool("philipsHue", philipsHue, null,
      "philipsHue(action, ...) - Control Philips Hue lights: on/off, brightness, color, scenes");

    api.registerTool("sonos", sonos, null,
      "sonos(action, ...) - Control Sonos speakers: play, pause, volume, queue, favorites");

    api.log.info("Registered: philipsHue, sonos");
  },
};
