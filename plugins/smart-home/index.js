import { philipsHue } from "../../src/tools/philipsHue.js";
import { sonos } from "../../src/tools/sonos.js";
import toolSchemas from "../../src/tools/schemas.js";

export default {
  id: "smart-home",
  name: "Smart Home",

  register(api) {
    api.registerTool("philipsHue", philipsHue, toolSchemas.philipsHue?.schema || null,
      "philipsHue(action, ...) — Control Philips Hue lights: on/off, brightness, color, scenes");

    api.registerTool("sonos", sonos, toolSchemas.sonos?.schema || null,
      "sonos(action, ...) — Control Sonos speakers: play, pause, volume, queue, favorites");

    api.log.info("Registered: philipsHue, sonos");
  },
};
