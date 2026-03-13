function dataUrlToBase64(dataUrl: string): string {
  const [, data] = dataUrl.split(',');
  return data ?? '';
}

export class VisionCapture {
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement;
  private canvasElement: HTMLCanvasElement;

  constructor() {
    this.videoElement = document.createElement('video');
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;
    this.videoElement.autoplay = true;

    this.canvasElement = document.createElement('canvas');
  }

  async start(): Promise<void> {
    if (this.stream) {
      return;
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
    });

    this.videoElement.srcObject = this.stream;
    await this.videoElement.play();
  }

  stop(): void {
    if (!this.stream) {
      return;
    }
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.videoElement.srcObject = null;
  }

  snapshot(maxWidth = 640, quality = 0.75): {
    data: string;
    mimeType: string;
  } | null {
    if (!this.stream || !this.videoElement.videoWidth || !this.videoElement.videoHeight) {
      return null;
    }

    const sourceWidth = this.videoElement.videoWidth;
    const sourceHeight = this.videoElement.videoHeight;
    const targetWidth = Math.min(maxWidth, sourceWidth);
    const targetHeight = Math.round((sourceHeight / sourceWidth) * targetWidth);

    this.canvasElement.width = targetWidth;
    this.canvasElement.height = targetHeight;
    const context = this.canvasElement.getContext('2d');
    if (!context) {
      return null;
    }

    context.drawImage(this.videoElement, 0, 0, targetWidth, targetHeight);
    const dataUrl = this.canvasElement.toDataURL('image/jpeg', quality);

    return {
      data: dataUrlToBase64(dataUrl),
      mimeType: 'image/jpeg',
    };
  }
}
