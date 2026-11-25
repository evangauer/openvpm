// Audio worklet for Scribe. Runs on the audio thread and hands mono samples to
// the page in blocks; the page does the segmenting and encoding.
class ScribePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.block[this.filled] = channel[i];
        this.filled += 1;
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("scribe-pcm-capture", ScribePcmCapture);
