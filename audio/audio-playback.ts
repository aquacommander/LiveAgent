import { decode, decodeAudioData } from '../utils';

export class AudioPlayback {
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  constructor(
    private readonly outputAudioContext: AudioContext,
    private readonly outputNode: AudioNode,
  ) {
    this.outputNode.connect(this.outputAudioContext.destination);
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  async playPCMBase64(
    base64Data: string,
    sampleRate = 24000,
    channels = 1,
  ): Promise<void> {
    this.nextStartTime = Math.max(
      this.nextStartTime,
      this.outputAudioContext.currentTime,
    );

    const audioBuffer = await decodeAudioData(
      decode(base64Data),
      this.outputAudioContext,
      sampleRate,
      channels,
    );

    const source = this.outputAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    source.addEventListener('ended', () => this.sources.delete(source));
    source.start(this.nextStartTime);

    this.sources.add(source);
    this.nextStartTime += audioBuffer.duration;
  }

  stopAll(): void {
    for (const source of this.sources) {
      source.stop();
      this.sources.delete(source);
    }
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  resetQueue(): void {
    this.stopAll();
    this.nextStartTime = this.outputAudioContext.currentTime;
  }
}
