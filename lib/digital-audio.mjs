// DSD emits 8 kHz PCM for digital voice and 48 kHz PCM for analog monitor rows.
// Keep frame boundaries across OS pipe reads, mix TDMA slots, and normalize output to 48 kHz.
export class DigitalAudio {
  constructor(channels = 1, inputRateHz = 8000) {
    if (![1, 2].includes(channels)) throw new Error('Digital PCM must have one or two channels.');
    if (![8000, 48000].includes(inputRateHz)) throw new Error('DSD PCM must be 8 kHz or 48 kHz.');
    this.channels = channels;
    this.inputRateHz = inputRateHz;
    this.remainder = Buffer.alloc(0);
    this.previous = null;
    this.frames = 0;
  }

  setFormat(channels, inputRateHz) {
    if (![1, 2].includes(channels) || ![8000, 48000].includes(inputRateHz)) return false;
    if (this.channels === channels && this.inputRateHz === inputRateHz) return false;
    this.channels = channels;
    this.inputRateHz = inputRateHz;
    this.remainder = Buffer.alloc(0);
    this.previous = null;
    return true;
  }

  push(chunk) {
    const bytes = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const stride = this.channels * 2;
    const frames = Math.floor(bytes.length / stride);
    this.remainder = Buffer.from(bytes.subarray(frames * stride));
    const upsample = this.inputRateHz === 8000 ? 6 : 1;
    const output = new Float32Array(frames * upsample);
    let power = 0;
    for (let i = 0; i < frames; i++) {
      const offset = i * stride;
      let sample = bytes.readInt16LE(offset) / 32768;
      if (this.channels === 2) sample = (sample + bytes.readInt16LE(offset + 2) / 32768) / 2;
      if (upsample === 1) {
        output[i] = sample;
        power += sample * sample;
      } else {
        const previous = this.previous ?? sample;
        for (let j = 1; j <= 6; j++) {
          const value = previous + (sample - previous) * j / 6;
          output[i * 6 + j - 1] = value;
          power += value * value;
        }
      }
      this.previous = sample;
    }
    this.frames += frames;
    return { samples: output, level: output.length ? Math.sqrt(power / output.length) : 0 };
  }
}
