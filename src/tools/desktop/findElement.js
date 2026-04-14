import { sidecarGet, sidecarPost } from "./_sidecar.js";
import { imageAnalysis } from "../imageAnalysis.js";

const COORD_RE = /\b(?:x\s*[:=]\s*)?(\d{1,4})\s*[,\s]\s*(?:y\s*[:=]\s*)?(\d{1,4})\b/i;

export async function desktopFindElement(params = {}) {
  const description = params.description;
  if (!description) return "Error: description required (e.g. 'the blue Sign In button')";

  const [shot, health] = await Promise.all([
    sidecarPost("/desktop/screenshot", {}),
    sidecarGet("/health").catch(() => ({})),
  ]);
  if (!shot?.path) return "Error: could not capture screenshot for vision lookup";

  const scaleX = Number(health?.screen?.scaleX) || (shot.width / (health?.screen?.width || shot.width)) || 1;
  const scaleY = Number(health?.screen?.scaleY) || (shot.height / (health?.screen?.height || shot.height)) || 1;

  const prompt = `You are a UI vision assistant. The screenshot is ${shot.width}x${shot.height} pixels. Locate this element: "${description}".

Respond with ONLY a single line in this exact format:
x=<number>, y=<number>

Use the CENTER of the element. Coordinates are in screenshot pixels from the top-left. If the element is not visible, respond with: NOT_FOUND`;

  const answer = await imageAnalysis({ imagePath: shot.path, prompt });
  if (typeof answer !== "string") return `Vision model returned unexpected response: ${JSON.stringify(answer)}`;
  if (/NOT_FOUND/i.test(answer)) return `Element not found on screen: "${description}"`;

  const m = answer.match(COORD_RE);
  if (!m) return `Could not parse coordinates from vision response: ${answer.slice(0, 200)}`;
  const physX = Number(m[1]);
  const physY = Number(m[2]);
  const clickX = Math.round(physX / scaleX);
  const clickY = Math.round(physY / scaleY);
  return `Element "${description}" located at screenshot pixel (${physX}, ${physY}). Click coordinates (scale-normalized for your display): x=${clickX}, y=${clickY}. Use desktopClick with x=${clickX}, y=${clickY}.`;
}
