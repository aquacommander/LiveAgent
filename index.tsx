/// <reference types="vite/client" />
/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { AudioCapture } from './audio/audio-capture';
import { AudioPlayback } from './audio/audio-playback';
import { LiveWebSocketClient } from './live/live-websocket-client';
import type { ServerToClientMessage } from './types/live-protocol';
import { VisionCapture } from './vision/vision-capture';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Booting...';
  @state() error = '';
  @state() showBackground = false;
  @state() showRings = false;
  @state() useDynamicColors = false;
  @state() useSmoothAnimations = false;
  @state() showSettings = false;
  @state() isConnected = false;
  @state() isSessionReady = false;
  @state() cameraEnabled = false;
  @state() autoSendVision = false;
  @state() lastModelText = '';

  private readonly inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private readonly outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({ sampleRate: 24000 });
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private readonly liveClient = new LiveWebSocketClient();
  private readonly visionCapture = new VisionCapture();
  private readonly audioPlayback = new AudioPlayback(
    this.outputAudioContext,
    this.outputNode,
  );
  private readonly audioCapture = new AudioCapture(
    this.inputAudioContext,
    this.inputNode,
    (chunk) => this.sendAudioChunk(chunk.data, chunk.mimeType),
  );
  private visionIntervalId: number | null = null;
  @query('#cameraPreview') private cameraPreviewElement?: HTMLVideoElement;

  static styles = css`
      #status {
        position: absolute;
        bottom: 5vh;
        left: 0;
        right: 0;
        z-index: 10;
        text-align: center;
        color: rgba(255, 255, 255, 0.6);
        font-family: 'Inter', sans-serif;
        font-size: 14px;
        pointer-events: none;
      }

      .controls {
        z-index: 100;
        position: absolute;
        bottom: 10vh;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: row;
        gap: 20px;

        button {
          outline: none;
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: white;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.05);
          width: 56px;
          height: 56px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
          backdrop-filter: blur(10px);

          &:hover {
            background: rgba(255, 255, 255, 0.15);
            transform: scale(1.05);
            border-color: rgba(255, 255, 255, 0.3);
          }

          svg {
            width: 24px;
            height: 24px;
          }
        }

        #startButton svg {
          fill: #ff3b30;
        }

        #stopButton svg {
          fill: #ffffff;
        }

        button[disabled] {
          opacity: 0.3;
          pointer-events: none;
        }
      }

      .settings-toggle {
        position: absolute;
        top: 30px;
        right: 30px;
        z-index: 100;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: white;
        padding: 10px;
        border-radius: 12px;
        cursor: pointer;
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;

        &:hover {
          background: rgba(255, 255, 255, 0.1);
        }
      }

      .settings-panel {
        position: absolute;
        top: 80px;
        right: 30px;
        z-index: 100;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 20px;
        border-radius: 16px;
        color: white;
        display: flex;
        flex-direction: column;
        gap: 15px;
        min-width: 220px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        animation: slideIn 0.3s ease-out;
      }

      @keyframes slideIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .toggle-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-family: 'Inter', sans-serif;
        font-size: 14px;
        cursor: pointer;

        input {
          cursor: pointer;
          accent-color: #007aff;
        }
      }

      .panel-header {
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: rgba(255, 255, 255, 0.4);
        margin-bottom: 5px;
      }

      .settings-backdrop {
        position: absolute;
        inset: 0;
        z-index: 95;
        background: transparent;
      }

      .camera-preview-shell {
        position: absolute;
        top: 24px;
        left: 24px;
        z-index: 90;
        width: 180px;
        height: 110px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 12px;
        overflow: hidden;
        backdrop-filter: blur(8px);
        background: rgba(0, 0, 0, 0.35);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
      }

      .camera-preview-shell[data-active='false'] {
        display: none;
      }

      .camera-preview-video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: scaleX(-1);
      }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.attachLiveHandlers();
    this.connectLive();
  }

  disconnectedCallback(): void {
    this.stopRecording();
    this.stopVisionAutoSend();
    this.visionCapture.stop();
    this.liveClient.close();
    super.disconnectedCallback();
  }

  protected updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('cameraEnabled')) {
      this.syncCameraPreview();
    }
  }

  private attachLiveHandlers(): void {
    this.liveClient.onMessage((message) => {
      this.handleLiveMessage(message);
    });
    this.liveClient.onError((message) => {
      this.updateError(message);
    });
    this.liveClient.onClose((reason) => {
      this.isConnected = false;
      this.isSessionReady = false;
      this.updateStatus(`Connection closed${reason ? `: ${reason}` : ''}`);
      this.stopVisionAutoSend();
    });
  }

  private async connectLive(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    const wsEndpoint =
      import.meta.env.VITE_LIVE_WS_URL ?? 'ws://localhost:8080/live';

    try {
      this.updateStatus('Connecting to live backend...');
      await this.liveClient.connect(wsEndpoint);
      this.isConnected = true;
      this.isSessionReady = false;
      this.liveClient.send({
        type: 'start_session',
        payload: {
          model: 'gemini-2.5-flash-native-audio-preview-09-2025',
          voiceName: 'Orus',
          responseModalities: ['AUDIO'],
        },
      });
      this.updateStatus('Connected. Preparing live session...');
    } catch (error) {
      this.updateError(
        error instanceof Error ? error.message : 'Unable to connect.',
      );
    }
  }

  private async handleLiveMessage(message: ServerToClientMessage): Promise<void> {
    if (message.type === 'session_ready') {
      this.isSessionReady = true;
      this.updateStatus(message.payload.message);
      return;
    }

    if (message.type === 'status') {
      this.updateStatus(message.payload.message);
      return;
    }

    if (message.type === 'error') {
      this.updateError(message.payload.message);
      return;
    }

    if (message.type === 'model_text') {
      this.lastModelText = message.payload.text;
      return;
    }

    if (message.type === 'interrupted') {
      this.audioPlayback.stopAll();
      return;
    }

    if (message.type === 'model_audio') {
      await this.audioPlayback.playPCMBase64(message.payload.data, 24000, 1);
    }
  }

  private updateStatus(msg: string) {
    this.error = '';
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    if (!this.isConnected) {
      await this.connectLive();
    }
    if (!this.isConnected) {
      return;
    }
    if (!this.isSessionReady) {
      this.updateStatus('Live session is still starting. Please try again.');
      return;
    }

    try {
      this.updateStatus('Requesting microphone access...');
      await this.audioCapture.start();
      this.isRecording = true;
      this.updateStatus('Recording live audio...');
      if (this.cameraEnabled && this.autoSendVision) {
        this.startVisionAutoSend();
      }
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    this.isRecording = false;
    this.audioCapture.stop();
    this.stopVisionAutoSend();
    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private sendAudioChunk(data: string, mimeType: string): void {
    if (!this.isConnected || !this.isRecording) {
      return;
    }
    this.liveClient.send({
      type: 'input_audio',
      payload: { data, mimeType },
    });
  }

  private async toggleCameraEnabled(enabled: boolean): Promise<void> {
    this.cameraEnabled = enabled;
    if (!enabled) {
      this.visionCapture.stop();
      this.stopVisionAutoSend();
      this.syncCameraPreview();
      this.updateStatus('Camera disabled.');
      return;
    }

    try {
      await this.visionCapture.start();
      this.syncCameraPreview();
      this.updateStatus('Camera enabled.');
      if (this.isRecording && this.autoSendVision) {
        this.startVisionAutoSend();
      }
    } catch (error) {
      this.cameraEnabled = false;
      this.updateError(
        error instanceof Error ? error.message : 'Unable to enable camera.',
      );
    }
  }

  private syncCameraPreview(): void {
    const video = this.cameraPreviewElement;
    if (!video) {
      return;
    }

    const stream = this.visionCapture.getStream();
    if (!this.cameraEnabled || !stream) {
      video.pause();
      video.srcObject = null;
      return;
    }

    video.srcObject = stream;
    void video.play();
  }

  private async sendVisionFrame(): Promise<void> {
    if (!this.isConnected || !this.cameraEnabled) {
      return;
    }

    const snapshot = this.visionCapture.snapshot();
    if (!snapshot) {
      this.updateStatus('No vision frame available yet.');
      return;
    }

    this.liveClient.send({
      type: 'input_image',
      payload: snapshot,
    });
    this.updateStatus('Vision frame sent.');
  }

  private startVisionAutoSend(): void {
    if (!this.autoSendVision) {
      return;
    }
    this.stopVisionAutoSend();
    this.visionIntervalId = window.setInterval(() => {
      this.sendVisionFrame();
    }, 3000);
  }

  private stopVisionAutoSend(): void {
    if (this.visionIntervalId !== null) {
      window.clearInterval(this.visionIntervalId);
      this.visionIntervalId = null;
    }
  }

  private reset() {
    this.stopRecording();
    this.audioPlayback.resetQueue();
    if (this.isConnected) {
      this.liveClient.send({ type: 'end_session' });
    }
    this.liveClient.close();
    this.isConnected = false;
    this.isSessionReady = false;
    this.connectLive();
    this.updateStatus('Session reset.');
  }

  render() {
    return html`
      <div>
        ${this.showSettings
          ? html`<div
              class="settings-backdrop"
              @click=${() => {
                this.showSettings = false;
              }}
            ></div>`
          : ''}

        <div class="camera-preview-shell" data-active=${String(this.cameraEnabled)}>
          <video
            id="cameraPreview"
            class="camera-preview-video"
            autoplay
            muted
            playsinline
          ></video>
        </div>

        <button class="settings-toggle" @click=${() => this.showSettings = !this.showSettings}>
          <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#FFFFFF"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5t1-13.5l-103-78 110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5t-1 13.5l103 78-110 190-119-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-58 0-99 41t-41 99q0 58 41 99t99 41Z"/></svg>
        </button>

        ${this.showSettings ? html`
          <div class="settings-panel">
            <div class="panel-header">Visual Features</div>
            <label class="toggle-item">
              Starfield
              <input type="checkbox" ?checked=${this.showBackground} @change=${(e: any) => this.showBackground = e.target.checked}>
            </label>
            <label class="toggle-item">
              Aura Rings
              <input type="checkbox" ?checked=${this.showRings} @change=${(e: any) => this.showRings = e.target.checked}>
            </label>
            <label class="toggle-item">
              Dynamic Colors
              <input type="checkbox" ?checked=${this.useDynamicColors} @change=${(e: any) => this.useDynamicColors = e.target.checked}>
            </label>
            <label class="toggle-item">
              Smooth Motion
              <input type="checkbox" ?checked=${this.useSmoothAnimations} @change=${(e: any) => this.useSmoothAnimations = e.target.checked}>
            </label>
            <div class="panel-header">Vision Features</div>
            <label class="toggle-item">
              Camera
              <input
                type="checkbox"
                ?checked=${this.cameraEnabled}
                @change=${(e: Event) =>
                  this.toggleCameraEnabled((e.target as HTMLInputElement).checked)}
              >
            </label>
            <label class="toggle-item">
              Auto Send Vision
              <input
                type="checkbox"
                ?checked=${this.autoSendVision}
                @change=${(e: Event) => {
                  this.autoSendVision = (e.target as HTMLInputElement).checked;
                  if (this.isRecording && this.cameraEnabled) {
                    if (this.autoSendVision) {
                      this.startVisionAutoSend();
                    } else {
                      this.stopVisionAutoSend();
                    }
                  }
                }}
              >
            </label>
            <button
              @click=${this.sendVisionFrame}
              ?disabled=${!this.cameraEnabled || !this.isConnected}
            >
              Send Vision Frame
            </button>
          </div>
        ` : ''}

        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="32px"
              viewBox="0 -960 960 960"
              width="32px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording || !this.isSessionReady}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status">
          ${this.error || this.status}
          ${this.lastModelText ? html`<div>${this.lastModelText}</div>` : ''}
        </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
          .showBackground=${this.showBackground}
          .showRings=${this.showRings}
          .useDynamicColors=${this.useDynamicColors}
          .useSmoothAnimations=${this.useSmoothAnimations}
        ></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
