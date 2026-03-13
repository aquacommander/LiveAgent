import { createBlob } from '../utils';

type ChunkHandler = (chunk: { data: string; mimeType: string }) => void;

export class AudioCapture {
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private readonly bufferSize = 256;

  constructor(
    private readonly inputAudioContext: AudioContext,
    private readonly inputNode: AudioNode,
    private readonly onChunk: ChunkHandler,
  ) {}

  async start(): Promise<void> {
    if (this.mediaStream) {
      return;
    }

    await this.inputAudioContext.resume();

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    this.sourceNode = this.inputAudioContext.createMediaStreamSource(
      this.mediaStream,
    );
    this.sourceNode.connect(this.inputNode);

    this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
      this.bufferSize,
      1,
      1,
    );

    this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
      if (!this.mediaStream) {
        return;
      }

      const inputBuffer = audioProcessingEvent.inputBuffer;
      const pcmData = inputBuffer.getChannelData(0);
      const blob = createBlob(pcmData);
      this.onChunk({ data: blob.data, mimeType: blob.mimeType });
    };

    this.sourceNode.connect(this.scriptProcessorNode);
    this.scriptProcessorNode.connect(this.inputAudioContext.destination);
  }

  stop(): void {
    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null;
      this.scriptProcessorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }
}
