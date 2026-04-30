/**
 * Whisper / Groq STT hallucination filter.
 *
 * These phrases are training artifacts — Whisper was trained on YouTube
 * audio where creators say "Thanks for watching, subscribe, thank you"
 * at video ends. When the model is given silence or low-energy noise,
 * the decoder falls into that training bias and produces the same
 * phrases. Dropping them before they reach the agent is mandatory;
 * otherwise the shared session fills up with phantom turns.
 *
 * This is a belt-and-braces layer — the primary defence is keeping
 * silent PCM out of the STT (`voiceEnergyGate.ts`). Anything that
 * still sneaks through lands here.
 */

const PATTERNS: readonly RegExp[] = [
  /^thank\s*you\.?$/i,
  /^thanks?(\s+for\s+(watching|listening))?\.?$/i,
  /^you\.?$/i,
  /^bye\.?$/i,
  /^okay\.?$/i,
  /^ok\.?$/i,
  /^please\s+subscribe\.?$/i,
  /^\.+$/,
  /^\s*$/,
  /^(thank\s*you[.,!\s]*){2,}/i,
  /^(thanks[.,!\s]*){2,}/i,
];

export function isHallucinatedTranscript(raw: string): boolean {
  const trimmed = raw.trim().replace(/^[.,!\s]+/, "").trim();
  if (!trimmed) return true;
  if (trimmed.length < 3) return true;
  return PATTERNS.some((re) => re.test(trimmed));
}
