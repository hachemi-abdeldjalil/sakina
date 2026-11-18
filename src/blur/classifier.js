// Heavy part of the 18+ blur, loaded only when blur is on.
// Bundled to dist/classifier.js (ES module) together with TensorFlow.js and the NSFW.js model.
import * as tf from '@tensorflow/tfjs';
import { load } from 'nsfwjs';

let modelPromise = null;

export function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      tf.enableProdMode();
      try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
      await tf.ready();
      const model = await load('MobileNetV2Mid', { type: 'graph' });
      return model;
    })();
  }
  return modelPromise;
}

// Returns { Porn, Hentai, Sexy, Neutral, Drawing } probabilities for a canvas.
export async function classify(canvas) {
  const model = await loadModel();
  const preds = await model.classify(canvas, 5);
  const out = { Porn: 0, Hentai: 0, Sexy: 0, Neutral: 0, Drawing: 0 };
  for (const p of preds) out[p.className] = p.probability;
  return out;
}

export function backend() { return tf.getBackend(); }
