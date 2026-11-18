// Adapter: wraps an initialised RNNoise emscripten module as a "voice model"
// for MusicSuppressor. RNNoise works on 480-sample frames at 48 kHz in int16 scale.
export const RNNOISE_FRAME = 480;
export const RNNOISE_DELAY = 960; // measured: output lags the input frame by 960 samples

export function createRnnoiseVoice(Module) {
  const state = Module._rnnoise_create(0);
  const pin = Module._malloc(RNNOISE_FRAME * 4);
  const pout = Module._malloc(RNNOISE_FRAME * 4);
  return {
    frameSize: RNNOISE_FRAME,
    delay: RNNOISE_DELAY,
    // input/output: Float32Array(480) in int16 scale. Returns voice probability 0..1.
    process(input, output) {
      Module.HEAPF32.set(input, pin >> 2);
      const vad = Module._rnnoise_process_frame(state, pout, pin);
      output.set(Module.HEAPF32.subarray(pout >> 2, (pout >> 2) + RNNOISE_FRAME));
      return vad;
    },
    destroy() {
      Module._rnnoise_destroy(state);
      Module._free(pin);
      Module._free(pout);
    },
  };
}
