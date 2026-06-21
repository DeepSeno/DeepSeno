// AudioWorklet processor — runs in AudioWorklet scope.
// Captures audio at native sample rate, downsamples to 16kHz, converts to int16 PCM.
// Plain JS because AudioWorklet code is inlined as data-URL and not transpiled.

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this._targetRate = opts.targetSampleRate || 16000;
    this._nativeRate = opts.nativeSampleRate || sampleRate;
    this._ratio = this._nativeRate / this._targetRate;
    this._resampleBuffer = [];
    this._callCount = 0;
  }

  process(inputs, _outputs, _params) {
    this._callCount++;
    const input = inputs[0];
    if (input && input[0]) {
      const float32 = input[0]; // 128 samples at native rate

      // Periodic diagnostic: log max float32 value to confirm audio is non-zero
      if (this._callCount === 1 || this._callCount === 100 || this._callCount % 500 === 0) {
        let maxAbs = 0;
        for (let i = 0; i < float32.length; i++) {
          const abs = Math.abs(float32[i]);
          if (abs > maxAbs) maxAbs = abs;
        }
        console.log(`[pcm-worklet] call=${this._callCount} float32.length=${float32.length} max=${maxAbs.toFixed(6)}`);
      }

      if (this._ratio <= 1.01) {
        // No resampling needed (native rate ≈ 16kHz)
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
      } else {
        // Downsample: accumulate samples, pick every Nth sample (simple decimation)
        for (let i = 0; i < float32.length; i++) {
          this._resampleBuffer.push(float32[i]);
        }

        // Calculate how many output samples we can produce
        const outCount = Math.floor(this._resampleBuffer.length / this._ratio);
        if (outCount > 0) {
          const int16 = new Int16Array(outCount);
          for (let i = 0; i < outCount; i++) {
            const srcIdx = Math.round(i * this._ratio);
            const s = Math.max(-1, Math.min(1, this._resampleBuffer[srcIdx]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          // Keep remainder samples for next call
          const consumed = Math.round(outCount * this._ratio);
          this._resampleBuffer = this._resampleBuffer.slice(consumed);
          this.port.postMessage(int16.buffer, [int16.buffer]);
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
