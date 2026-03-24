import { describe, it, expect } from "vitest";
import { pcmToMulaw, mulawToPcm, resamplePcm, pcmToMulaw8k, chunkBuffer } from "../../../src/meeting/TelephonyAudio.js";

describe("TelephonyAudio", () => {
  it("pcmToMulaw converts PCM buffer to mu-law", () => {
    // Create a simple PCM buffer (16-bit signed, 4 samples)
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(1000, 2);
    pcm.writeInt16LE(-1000, 4);
    pcm.writeInt16LE(32767, 6);

    const mulaw = pcmToMulaw(pcm);
    expect(mulaw).toBeInstanceOf(Buffer);
    expect(mulaw.length).toBe(4); // 4 samples → 4 bytes
  });

  it("mulawToPcm converts mu-law back to PCM", () => {
    const mulaw = Buffer.from([0xff, 0x80, 0x00, 0x7f]);
    const pcm = mulawToPcm(mulaw);
    expect(pcm).toBeInstanceOf(Buffer);
    expect(pcm.length).toBe(8); // 4 mu-law bytes → 4 16-bit samples = 8 bytes
  });

  it("roundtrip preserves signal approximately", () => {
    const original = Buffer.alloc(8);
    original.writeInt16LE(5000, 0);
    original.writeInt16LE(-5000, 2);
    original.writeInt16LE(10000, 4);
    original.writeInt16LE(-10000, 6);

    const mulaw = pcmToMulaw(original);
    const restored = mulawToPcm(mulaw);

    // mu-law is lossy - values won't be exact but should be close
    for (let i = 0; i < 4; i++) {
      const orig = original.readInt16LE(i * 2);
      const rest = restored.readInt16LE(i * 2);
      expect(Math.abs(orig - rest)).toBeLessThan(500); // within ~500 of original
    }
  });

  it("resamplePcm resamples from 24kHz to 8kHz", () => {
    // 24 samples at 24kHz = 1ms of audio
    const input = Buffer.alloc(48); // 24 samples × 2 bytes
    for (let i = 0; i < 24; i++) {
      input.writeInt16LE(Math.round(Math.sin(i / 24 * Math.PI * 2) * 10000), i * 2);
    }

    const output = resamplePcm(input, 24000, 8000);
    expect(output.length).toBe(16); // 8 samples × 2 bytes (24/3 = 8)
  });

  it("pcmToMulaw8k resamples + converts", () => {
    const pcm24k = Buffer.alloc(48); // 24 samples at 24kHz
    for (let i = 0; i < 24; i++) {
      pcm24k.writeInt16LE(1000, i * 2);
    }

    const mulaw8k = pcmToMulaw8k(pcm24k, 24000);
    expect(mulaw8k).toBeInstanceOf(Buffer);
    expect(mulaw8k.length).toBe(8); // 8 samples after resample
  });

  it("chunkBuffer splits into 160-byte chunks", () => {
    const buf = Buffer.alloc(500);
    const chunks = chunkBuffer(buf, 160);
    expect(chunks).toHaveLength(3); // 160 + 160 + 180 → 3 chunks (last is 180)
    expect(chunks[0].length).toBe(160);
    expect(chunks[1].length).toBe(160);
    expect(chunks[2].length).toBe(180);
  });

  it("chunkBuffer handles exact multiple", () => {
    const buf = Buffer.alloc(320);
    const chunks = chunkBuffer(buf, 160);
    expect(chunks).toHaveLength(2);
  });

  it("chunkBuffer handles smaller than chunk", () => {
    const buf = Buffer.alloc(100);
    const chunks = chunkBuffer(buf, 160);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(100);
  });
});
