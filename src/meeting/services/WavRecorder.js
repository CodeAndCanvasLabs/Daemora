/**
 * WavRecorder — PCM audio to WAV file writer.
 *
 * Based on Vexa's recording.ts pattern:
 * - Float32 → Int16 PCM conversion with clamping
 * - RIFF/WAV header (44 bytes) with correct sizes
 * - Placeholder header on start, rewritten on finalize with actual data size
 * - Atomic finalize: close stream → reopen → rewrite header → close
 */

import { createWriteStream, openSync, writeSync, closeSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/default.js";

export default class WavRecorder {
  /**
   * @param {string} sessionId — meeting session ID
   * @param {number} [sampleRate=16000]
   * @param {number} [channels=1]
   */
  constructor(sessionId, sampleRate = 16000, channels = 1) {
    const dir = join(config.dataDir, "meetings");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `recording-${sessionId}-${Date.now()}.wav`);
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = 16;
    this.totalSamples = 0;
    this.stream = null;
    this.started = false;
  }

  /** Start recording — writes placeholder WAV header */
  start() {
    this.stream = createWriteStream(this.path);
    this.stream.write(this._createHeader(0)); // placeholder — rewritten on finalize
    this.totalSamples = 0;
    this.started = true;
    console.log(`[WavRecorder] Started: ${this.path}`);
  }

  /**
   * Append Float32Array audio chunk.
   * Converts Float32 [-1, 1] → Int16 [-32768, 32767] PCM.
   */
  appendFloat32(float32Data) {
    if (!this.stream || !this.started) return;
    const pcm = this._float32ToInt16(float32Data);
    this.stream.write(pcm);
    this.totalSamples += float32Data.length;
  }

  /**
   * Finalize recording — close stream, rewrite header with correct sizes.
   * @returns {Promise<string>} path to the finalized WAV file
   */
  async finalize() {
    if (!this.stream || !this.started) return this.path;
    this.started = false;

    // Close write stream
    await new Promise((resolve) => this.stream.end(resolve));

    // Rewrite WAV header with actual data size
    const dataSize = this.totalSamples * (this.bitsPerSample / 8) * this.channels;
    const header = this._createHeader(dataSize);
    try {
      const fd = openSync(this.path, "r+");
      writeSync(fd, header, 0, 44, 0);
      closeSync(fd);
    } catch (e) {
      console.log(`[WavRecorder] Header rewrite failed: ${e.message}`);
    }

    const durationSec = (this.totalSamples / this.sampleRate).toFixed(1);
    const fileSize = statSync(this.path).size;
    console.log(`[WavRecorder] Finalized: ${this.path} (${durationSec}s, ${(fileSize / 1024).toFixed(0)}KB)`);
    return this.path;
  }

  /**
   * Float32 [-1, 1] → Int16 [-32768, 32767] with clamping.
   * Exact Vexa pattern.
   */
  _float32ToInt16(float32Data) {
    const buffer = Buffer.alloc(float32Data.length * 2);
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i])); // clamp
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      buffer.writeInt16LE(Math.round(val), i * 2);
    }
    return buffer;
  }

  /**
   * Create 44-byte RIFF/WAV header.
   * @param {number} dataSize — PCM data size in bytes
   */
  _createHeader(dataSize) {
    const header = Buffer.alloc(44);
    const byteRate = this.sampleRate * this.channels * (this.bitsPerSample / 8);
    const blockAlign = this.channels * (this.bitsPerSample / 8);

    header.write("RIFF", 0);                          // ChunkID
    header.writeUInt32LE(36 + dataSize, 4);           // ChunkSize
    header.write("WAVE", 8);                          // Format
    header.write("fmt ", 12);                         // Subchunk1ID
    header.writeUInt32LE(16, 16);                     // Subchunk1Size (PCM = 16)
    header.writeUInt16LE(1, 20);                      // AudioFormat (PCM = 1)
    header.writeUInt16LE(this.channels, 22);          // NumChannels
    header.writeUInt32LE(this.sampleRate, 24);        // SampleRate
    header.writeUInt32LE(byteRate, 28);               // ByteRate
    header.writeUInt16LE(blockAlign, 32);             // BlockAlign
    header.writeUInt16LE(this.bitsPerSample, 34);     // BitsPerSample
    header.write("data", 36);                         // Subchunk2ID
    header.writeUInt32LE(dataSize, 40);               // Subchunk2Size

    return header;
  }
}
