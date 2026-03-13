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
import type {
  AgentMode,
  RequirementProfile,
  ServerToClientMessage,
  StoryOutputPack,
  StoryPart,
  StorySafetyReport,
  StoryQualityReport,
} from './types/live-protocol';
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
  @state() agentMode: AgentMode = 'conversation';
  @state() requirementProfile: RequirementProfile | null = null;
  @state() clarificationQuestion = '';
  @state() storyParts: StoryPart[] = [];
  @state() storySummary = '';
  @state() showIntelligencePanel = false;
  @state() speakingStoryPartKey = '';
  @state() storyRenderStatusByScene: Record<string, { status: string; message: string }> = {};
  @state() storyQualityReport: StoryQualityReport | null = null;
  @state() storySafetyReport: StorySafetyReport | null = null;
  @state() storyOutputPacks: StoryOutputPack[] = [];
  private storyVoiceAudioElement: HTMLAudioElement | null = null;
  private storyVoiceObjectUrl: string | null = null;

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
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      .app-shell {
        position: relative;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
      }

      .branding {
        position: absolute;
        top: 32px;
        left: 34px;
        z-index: 101;
        color: rgba(226, 236, 255, 0.92);
        font-family: 'Inter', sans-serif;
        user-select: none;
        pointer-events: none;
      }

      .branding h1 {
        margin: 0;
        font-size: 36px;
        line-height: 1;
        letter-spacing: 2px;
        font-weight: 700;
      }

      .branding p {
        margin: 10px 0 0;
        font-size: 18px;
        color: rgba(202, 214, 238, 0.72);
        letter-spacing: 0.3px;
      }

      #status {
        position: absolute;
        bottom: 4vh;
        left: 0;
        right: 0;
        z-index: 101;
        text-align: center;
        color: rgba(223, 233, 251, 0.8);
        font-family: 'Inter', sans-serif;
        font-size: 18px;
        letter-spacing: 0.3px;
        pointer-events: none;
      }

      .status-text {
        display: inline-block;
        padding: 10px 20px;
        border-radius: 14px;
        background: rgba(6, 15, 36, 0.36);
        border: 1px solid rgba(115, 155, 255, 0.25);
        box-shadow: 0 0 28px rgba(45, 127, 255, 0.25);
      }

      .status-text::after {
        content: '';
        display: block;
        margin: 8px auto 0;
        width: 180px;
        height: 2px;
        border-radius: 999px;
        background: linear-gradient(
          90deg,
          rgba(0, 241, 255, 0),
          rgba(95, 190, 255, 0.95),
          rgba(0, 241, 255, 0)
        );
      }

      .controls {
        z-index: 101;
        position: absolute;
        bottom: 14vh;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: row;
        gap: 20px;

        button {
          outline: none;
          border: 1px solid rgba(126, 177, 255, 0.28);
          color: white;
          border-radius: 50%;
          background: radial-gradient(
            circle at 30% 20%,
            rgba(43, 73, 128, 0.34),
            rgba(9, 22, 50, 0.6)
          );
          width: 82px;
          height: 82px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
          backdrop-filter: blur(12px);
          box-shadow:
            inset 0 0 15px rgba(154, 201, 255, 0.15),
            0 0 20px rgba(56, 139, 255, 0.15);

          &:hover {
            transform: translateY(-2px) scale(1.02);
            border-color: rgba(172, 212, 255, 0.7);
            box-shadow:
              inset 0 0 20px rgba(170, 212, 255, 0.2),
              0 0 24px rgba(73, 161, 255, 0.35);
          }

          svg {
            width: 34px;
            height: 34px;
          }
        }

        #startButton svg {
          fill: #ff3b30;
        }

        #startButton {
          box-shadow:
            inset 0 0 25px rgba(255, 108, 108, 0.2),
            0 0 30px rgba(255, 66, 66, 0.32);
        }

        #stopButton svg {
          fill: #ffffff;
        }

        button[disabled] {
          opacity: 0.3;
          pointer-events: none;
        }
      }

      .top-actions {
        position: absolute;
        top: 24px;
        right: 24px;
        z-index: 102;
        display: flex;
        gap: 8px;
        padding: 6px;
        border-radius: 20px;
        background: rgba(8, 21, 48, 0.38);
        border: 1px solid rgba(134, 177, 255, 0.25);
        backdrop-filter: blur(10px);
        box-shadow: 0 0 18px rgba(68, 160, 255, 0.18);
      }

      .top-action-button {
        width: 44px;
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(139, 183, 255, 0.25);
        background: radial-gradient(
          circle at 30% 25%,
          rgba(46, 86, 154, 0.46),
          rgba(7, 16, 36, 0.72)
        );
        color: rgba(218, 232, 255, 0.95);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.25s ease;
      }

      .top-action-button:hover {
        transform: translateY(-1px);
        border-color: rgba(173, 210, 255, 0.7);
        box-shadow: 0 0 16px rgba(87, 170, 255, 0.4);
      }

      .top-action-button svg {
        width: 22px;
        height: 22px;
      }

      .top-action-button[data-active='true'] {
        border-color: rgba(160, 218, 255, 0.75);
        box-shadow: 0 0 16px rgba(98, 196, 255, 0.45);
      }

      .settings-panel {
        position: absolute;
        top: 82px;
        right: 24px;
        z-index: 140;
        background: rgba(4, 14, 31, 0.72);
        backdrop-filter: blur(18px);
        border: 1px solid rgba(143, 184, 255, 0.2);
        padding: 20px;
        border-radius: 22px;
        color: rgba(228, 238, 255, 0.95);
        display: flex;
        flex-direction: column;
        gap: 15px;
        min-width: 280px;
        box-shadow: 0 18px 45px rgba(0,0,0,0.48);
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
        color: rgba(165, 182, 210, 0.55);
        margin-bottom: 5px;
      }

      .settings-backdrop {
        position: absolute;
        inset: 0;
        z-index: 135;
        background: transparent;
      }

      .camera-preview-shell {
        position: absolute;
        top: 22px;
        left: 22px;
        z-index: 140;
        width: 390px;
        height: 240px;
        border: 1px solid rgba(128, 190, 255, 0.55);
        border-radius: 14px;
        overflow: hidden;
        background: #000;
        box-shadow:
          0 14px 28px rgba(0, 0, 0, 0.55),
          0 0 18px rgba(76, 197, 255, 0.35);
      }

      .camera-preview-shell[data-active='false'] {
        display: none;
      }

      .camera-preview-video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: scaleX(-1);
        background: #000;
      }

      .send-vision-button {
        border-radius: 10px;
        height: 40px;
        border: 1px solid rgba(142, 185, 255, 0.32);
        background: rgba(14, 32, 64, 0.9);
        color: rgba(233, 241, 255, 0.96);
        font-size: 16px;
        cursor: pointer;
      }

      .send-vision-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .story-panel {
        position: absolute;
        top: 172px;
        left: 24px;
        z-index: 103;
        width: min(380px, calc(100vw - 34px));
        height: clamp(280px, calc(100vh - 210px), 575px);
        overflow: auto;
        border-radius: 18px;
        background: rgba(5, 12, 30, 0.76);
        border: 1px solid rgba(142, 189, 255, 0.28);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
        padding: 14px;
        backdrop-filter: blur(14px);
        transition:
          opacity 280ms ease,
          transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
        transform-origin: right center;
        opacity: 1;
        transform: translateX(0) scale(1);
      }

      .story-panel[data-open='false'] {
        opacity: 0;
        transform: translateX(28px) scale(0.98);
        pointer-events: none;
      }

      .story-panel h3 {
        margin: 0;
        font-size: 13px;
        letter-spacing: 1px;
        text-transform: uppercase;
        color: rgba(172, 197, 241, 0.9);
      }

      .panel-empty-state {
        margin-top: 10px;
        border-radius: 10px;
        border: 1px dashed rgba(134, 176, 247, 0.3);
        padding: 10px;
        color: rgba(194, 218, 255, 0.72);
        font-size: 12px;
      }

      .story-mode-chip {
        margin-top: 8px;
        display: inline-flex;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid rgba(130, 179, 255, 0.4);
        color: rgba(223, 236, 255, 0.95);
        font-size: 12px;
      }

      .story-card {
        margin-top: 10px;
        border-radius: 12px;
        border: 1px solid rgba(116, 162, 247, 0.2);
        background: rgba(11, 24, 52, 0.68);
        padding: 10px;
      }

      .story-kind {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.7px;
        color: rgba(156, 184, 236, 0.82);
      }

      .story-render-status {
        margin-top: 6px;
        display: inline-flex;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 11px;
        border: 1px solid rgba(120, 164, 247, 0.35);
        color: rgba(212, 230, 255, 0.95);
      }

      .story-render-status[data-state='rendering'],
      .story-render-status[data-state='queued'] {
        border-color: rgba(126, 177, 255, 0.45);
      }

      .story-render-status[data-state='ready'] {
        border-color: rgba(100, 214, 170, 0.55);
        color: rgba(184, 255, 230, 0.95);
      }

      .story-render-status[data-state='failed'] {
        border-color: rgba(255, 132, 132, 0.55);
        color: rgba(255, 206, 206, 0.95);
      }

      .story-quality-badge {
        margin-top: 6px;
        display: inline-flex;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 11px;
        border: 1px solid rgba(120, 164, 247, 0.35);
        color: rgba(212, 230, 255, 0.95);
      }

      .story-quality-badge[data-state='passed'] {
        border-color: rgba(100, 214, 170, 0.55);
        color: rgba(184, 255, 230, 0.95);
      }

      .story-quality-badge[data-state='revised'] {
        border-color: rgba(255, 196, 104, 0.55);
        color: rgba(255, 232, 184, 0.95);
      }

      .story-quality-badge[data-state='failed'] {
        border-color: rgba(255, 132, 132, 0.55);
        color: rgba(255, 206, 206, 0.95);
      }

      .story-content {
        margin-top: 6px;
        font-size: 13px;
        line-height: 1.45;
        color: rgba(228, 238, 255, 0.95);
      }

      .story-media {
        margin-top: 8px;
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid rgba(121, 166, 247, 0.2);
        background: rgba(9, 22, 48, 0.8);
      }

      .story-media img,
      .story-media video {
        width: 100%;
        display: block;
      }

      .story-audio-controls {
        margin-top: 8px;
        display: flex;
        gap: 8px;
      }

      .story-audio-button {
        border: 1px solid rgba(129, 177, 255, 0.35);
        background: rgba(14, 30, 66, 0.88);
        color: rgba(229, 240, 255, 0.96);
        border-radius: 8px;
        font-size: 12px;
        padding: 6px 10px;
        cursor: pointer;
      }

      .story-audio-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .summary-text {
        margin-top: 10px;
        font-size: 12px;
        color: rgba(195, 220, 255, 0.85);
      }

      .quality-summary {
        margin-top: 10px;
        font-size: 12px;
        color: rgba(183, 228, 255, 0.88);
      }

      .safety-summary {
        margin-top: 8px;
        font-size: 12px;
        display: inline-flex;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid rgba(128, 176, 255, 0.35);
        color: rgba(214, 232, 255, 0.95);
      }

      .safety-summary[data-state='safe'] {
        border-color: rgba(100, 214, 170, 0.55);
        color: rgba(184, 255, 230, 0.95);
      }

      .safety-summary[data-state='review'] {
        border-color: rgba(255, 196, 104, 0.55);
        color: rgba(255, 232, 184, 0.95);
      }

      .safety-summary[data-state='blocked'] {
        border-color: rgba(255, 132, 132, 0.55);
        color: rgba(255, 206, 206, 0.95);
      }

      .output-pack-title {
        margin-top: 8px;
        font-size: 12px;
        color: rgba(200, 226, 255, 0.92);
      }

      .output-pack-content {
        margin-top: 6px;
        white-space: pre-wrap;
        font-size: 12px;
        line-height: 1.45;
        color: rgba(223, 238, 255, 0.9);
      }

      .intelligence-toggle-button[data-active='true'] {
        border-color: rgba(160, 218, 255, 0.75);
        box-shadow: 0 0 16px rgba(98, 196, 255, 0.45);
      }

      .requirement-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }

      .requirement-item {
        padding: 8px;
        border-radius: 10px;
        background: rgba(11, 24, 52, 0.55);
        border: 1px solid rgba(124, 170, 248, 0.15);
      }

      .requirement-item strong {
        display: block;
        font-size: 11px;
        color: rgba(152, 184, 247, 0.85);
      }

      .requirement-item span {
        font-size: 12px;
        color: rgba(224, 236, 255, 0.92);
      }

      @media (max-width: 1200px) {
        .branding h1 {
          font-size: 32px;
        }

        .branding p {
          font-size: 16px;
        }

        .camera-preview-shell {
          width: 320px;
          height: 198px;
        }

        .story-panel {
          width: min(340px, calc(100vw - 24px));
          height: clamp(260px, calc(100vh - 190px), 520px);
        }
      }

      @media (max-width: 900px) {
        .branding {
          top: 20px;
          left: 18px;
        }

        .branding h1 {
          font-size: 26px;
        }

        .branding p {
          margin-top: 6px;
          font-size: 13px;
        }

        .top-actions {
          top: 14px;
          right: 14px;
          gap: 6px;
          padding: 5px;
        }

        .top-action-button {
          width: 40px;
          height: 40px;
          border-radius: 12px;
        }

        .top-action-button svg {
          width: 20px;
          height: 20px;
        }

        .camera-preview-shell {
          top: 72px;
          left: 14px;
          width: 220px;
          height: 136px;
        }

        .story-panel {
          top: 72px;
          left: 14px;
          width: min(320px, calc(100vw - 20px));
          height: clamp(240px, calc(100vh - 160px), 460px);
          padding: 12px;
        }

        .controls {
          bottom: 12vh;
          gap: 14px;
        }

        .controls button {
          width: 68px;
          height: 68px;
        }

        .controls button svg {
          width: 28px;
          height: 28px;
        }

        #status {
          bottom: 2.2vh;
          font-size: 15px;
        }
      }

      @media (max-width: 640px) {
        .branding {
          top: 14px;
          left: 12px;
          max-width: 62vw;
        }

        .branding h1 {
          font-size: 20px;
          letter-spacing: 1px;
        }

        .branding p {
          font-size: 11px;
          line-height: 1.3;
        }

        .camera-preview-shell {
          top: 62px;
          left: 12px;
          width: 42vw;
          max-width: 176px;
          height: 108px;
        }

        .story-panel {
          top: 62px;
          left: 12px;
          width: 52vw;
          min-width: 188px;
          height: clamp(220px, calc(100vh - 150px), 410px);
          border-radius: 14px;
          padding: 10px;
        }

        .story-panel h3 {
          font-size: 11px;
          letter-spacing: 0.7px;
        }

        .story-mode-chip {
          font-size: 10px;
          padding: 4px 8px;
        }

        .story-content {
          font-size: 12px;
        }

        .requirement-grid {
          grid-template-columns: 1fr;
        }

        .controls {
          bottom: 11vh;
        }

        .controls button {
          width: 60px;
          height: 60px;
        }

        .controls button svg {
          width: 24px;
          height: 24px;
        }

        .status-text {
          padding: 8px 14px;
          font-size: 13px;
        }
      }

      @supports (height: 100dvh) {
        .story-panel {
          height: clamp(280px, calc(100dvh - 210px), 575px);
        }

        @media (max-width: 1200px) {
          .story-panel {
            height: clamp(260px, calc(100dvh - 190px), 520px);
          }
        }

        @media (max-width: 900px) {
          .story-panel {
            height: clamp(240px, calc(100dvh - 160px), 460px);
          }
        }

        @media (max-width: 640px) {
          .story-panel {
            height: clamp(220px, calc(100dvh - 150px), 410px);
          }
        }
      }

      @supports (height: 100svh) {
        .story-panel {
          height: clamp(280px, calc(100svh - 210px), 575px);
        }

        @media (max-width: 1200px) {
          .story-panel {
            height: clamp(260px, calc(100svh - 190px), 520px);
          }
        }

        @media (max-width: 900px) {
          .story-panel {
            height: clamp(240px, calc(100svh - 160px), 460px);
          }
        }

        @media (max-width: 640px) {
          .story-panel {
            height: clamp(220px, calc(100svh - 150px), 410px);
          }
        }
      }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.attachLiveHandlers();
    this.connectLive();
  }

  disconnectedCallback(): void {
    this.stopVoiceoverPlayback();
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

    if (message.type === 'mode_changed') {
      this.agentMode = message.payload.mode;
      this.updateStatus(message.payload.reason);
      if (this.agentMode === 'conversation') {
        this.storySummary = '';
        this.storySafetyReport = null;
        this.storyOutputPacks = [];
      }
      return;
    }

    if (message.type === 'requirement_profile_updated') {
      this.requirementProfile = message.payload.profile;
      return;
    }

    if (message.type === 'clarification_question') {
      this.clarificationQuestion = message.payload.question;
      return;
    }

    if (message.type === 'story_part') {
      this.storyParts = [...this.storyParts, message.payload];
      return;
    }

    if (message.type === 'story_scene_revised') {
      const revisedScene = message.payload.sceneId;
      const preserved = this.storyParts.filter((part) => part.sceneId !== revisedScene);
      this.storyParts = [...preserved, ...message.payload.parts].sort(
        (a, b) => a.sequence - b.sequence,
      );
      this.updateStatus(`Updated ${revisedScene} with your latest request.`);
      return;
    }

    if (message.type === 'story_generation_done') {
      this.storySummary = message.payload.summary;
      this.updateStatus('Creative story generated.');
      return;
    }

    if (message.type === 'story_quality_report') {
      this.storyQualityReport = message.payload.report;
      return;
    }

    if (message.type === 'story_safety_report') {
      this.storySafetyReport = message.payload.report;
      return;
    }

    if (message.type === 'story_output_packs') {
      this.storyOutputPacks = message.payload.packs;
      return;
    }

    if (message.type === 'story_render_status') {
      this.storyRenderStatusByScene = {
        ...this.storyRenderStatusByScene,
        [message.payload.sceneId]: {
          status: message.payload.status,
          message: message.payload.message,
        },
      };
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

  private async copyPackContent(pack: StoryOutputPack): Promise<void> {
    if (!navigator?.clipboard?.writeText) {
      this.updateError('Clipboard API is not available in this browser.');
      return;
    }
    try {
      await navigator.clipboard.writeText(pack.content);
      this.updateStatus(`${pack.title} copied to clipboard.`);
    } catch {
      this.updateError(`Unable to copy ${pack.title}.`);
    }
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

  private getStoryPartKey(part: StoryPart): string {
    return `${part.sceneId}-${part.sequence}-${part.kind}`;
  }

  private getSceneQualityFinding(sceneId: string) {
    return this.storyQualityReport?.findings.find(
      (finding) => finding.sceneId === sceneId,
    );
  }

  private base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  private playVoiceoverPart(part: StoryPart): void {
    this.stopVoiceoverPlayback();

    if (part.data && part.mimeType && part.mimeType.startsWith('audio/')) {
      try {
        const blob = this.base64ToBlob(part.data, part.mimeType);
        const objectUrl = URL.createObjectURL(blob);
        const audio = new Audio(objectUrl);
        audio.onended = () => {
          this.speakingStoryPartKey = '';
          if (this.storyVoiceObjectUrl) {
            URL.revokeObjectURL(this.storyVoiceObjectUrl);
            this.storyVoiceObjectUrl = null;
          }
          this.storyVoiceAudioElement = null;
        };
        audio.onerror = () => {
          this.speakingStoryPartKey = '';
          this.updateError('Failed to play generated voiceover audio.');
          if (this.storyVoiceObjectUrl) {
            URL.revokeObjectURL(this.storyVoiceObjectUrl);
            this.storyVoiceObjectUrl = null;
          }
          this.storyVoiceAudioElement = null;
        };

        this.storyVoiceAudioElement = audio;
        this.storyVoiceObjectUrl = objectUrl;
        this.speakingStoryPartKey = this.getStoryPartKey(part);
        void audio.play();
        return;
      } catch {
        // Fallback below if blob playback fails.
      }
    }

    if (typeof window === 'undefined' || !window.speechSynthesis) {
      this.updateError('Voiceover playback is not supported in this browser.');
      return;
    }

    const utterance = new SpeechSynthesisUtterance(part.content);
    utterance.rate = 0.97;
    utterance.pitch = 1.0;
    utterance.onend = () => {
      this.speakingStoryPartKey = '';
    };
    utterance.onerror = () => {
      this.speakingStoryPartKey = '';
      this.updateError('Failed to play voiceover audio.');
    };

    this.speakingStoryPartKey = this.getStoryPartKey(part);
    window.speechSynthesis.speak(utterance);
  }

  private stopVoiceoverPlayback(): void {
    if (this.storyVoiceAudioElement) {
      this.storyVoiceAudioElement.pause();
      this.storyVoiceAudioElement.currentTime = 0;
      this.storyVoiceAudioElement = null;
    }
    if (this.storyVoiceObjectUrl) {
      URL.revokeObjectURL(this.storyVoiceObjectUrl);
      this.storyVoiceObjectUrl = null;
    }

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    this.speakingStoryPartKey = '';
  }

  private reset() {
    this.stopVoiceoverPlayback();
    this.stopRecording();
    this.audioPlayback.resetQueue();
    if (this.isConnected) {
      this.liveClient.send({ type: 'end_session' });
    }
    this.liveClient.close();
    this.isConnected = false;
    this.isSessionReady = false;
    this.agentMode = 'conversation';
    this.requirementProfile = null;
    this.clarificationQuestion = '';
    this.storyParts = [];
    this.storySummary = '';
    this.storyRenderStatusByScene = {};
    this.storyQualityReport = null;
    this.storySafetyReport = null;
    this.storyOutputPacks = [];
    this.connectLive();
    this.updateStatus('Session reset.');
  }

  render() {
    return html`
      <div class="app-shell">
        ${this.showSettings
          ? html`<div
              class="settings-backdrop"
              @click=${() => {
                this.showSettings = false;
              }}
            ></div>`
          : ''}

        <div class="branding">
          <h1>AUDIO ORB</h1>
          <p>Talk, create, and act — one conversation.</p>
        </div>

        <div class="camera-preview-shell" data-active=${String(this.cameraEnabled)}>
          <video
            id="cameraPreview"
            class="camera-preview-video"
            autoplay
            muted
            playsinline
          ></video>
        </div>

        <div class="top-actions">
          <button
            class="top-action-button"
            title="Settings"
            data-active=${String(this.showSettings)}
            @click=${() => (this.showSettings = !this.showSettings)}>
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5t1-13.5l-103-78 110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5t-1 13.5l103 78-110 190-119-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-58 0-99 41t-41 99q0 58 41 99t99 41Z"/></svg>
          </button>
          <button
            class="top-action-button intelligence-toggle-button"
            title=${this.showIntelligencePanel
              ? 'Hide Live Agent Intelligence'
              : 'Show Live Agent Intelligence'}
            data-active=${String(this.showIntelligencePanel)}
            @click=${() => {
              this.showIntelligencePanel = !this.showIntelligencePanel;
            }}>
            ${this.showIntelligencePanel
              ? html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M440-280 280-440l56-58 104 104 184-184 56 58-240 240Z"/></svg>`
              : html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M360-280v-400l280 200-280 200Z"/></svg>`}
          </button>
        </div>

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
              class="send-vision-button"
              @click=${this.sendVisionFrame}
              ?disabled=${!this.cameraEnabled || !this.isConnected}
            >
              Send Vision Frame
            </button>
          </div>
        ` : ''}

        <div class="story-panel" data-open=${String(this.showIntelligencePanel)}>
          <h3>Live Agent Intelligence</h3>
          <div class="story-mode-chip">
            Mode: ${this.agentMode === 'creative_storyteller' ? 'Creative Storyteller' : 'Requirement Discovery'}
          </div>
          ${this.clarificationQuestion
            ? html`
                <div class="story-card">
                  <div class="story-kind">Clarification</div>
                  <div class="story-content">${this.clarificationQuestion}</div>
                </div>
              `
            : ''}
          ${this.requirementProfile
            ? html`
                <div class="requirement-grid">
                  <div class="requirement-item"><strong>Objective</strong><span>${this.requirementProfile.objective}</span></div>
                  <div class="requirement-item"><strong>Audience</strong><span>${this.requirementProfile.audience}</span></div>
                  <div class="requirement-item"><strong>Tone</strong><span>${this.requirementProfile.tone}</span></div>
                  <div class="requirement-item"><strong>Style</strong><span>${this.requirementProfile.style}</span></div>
                </div>
              `
            : ''}
          ${this.storyParts.length === 0 &&
          !this.storySummary &&
          !this.clarificationQuestion
            ? html`
                <div class="panel-empty-state">
                  The intelligence stream will appear here after your first request.
                </div>
              `
            : ''}
          ${this.storyParts.map(
            (part) => html`
              <div class="story-card">
                <div class="story-kind">${part.sceneId} · ${part.kind}</div>
                ${part.kind === 'storyboard' && this.storyRenderStatusByScene[part.sceneId]
                  ? html`
                      <div
                        class="story-render-status"
                        data-state=${this.storyRenderStatusByScene[part.sceneId].status}
                      >
                        ${this.storyRenderStatusByScene[part.sceneId].message}
                      </div>
                    `
                  : ''}
                ${(() => {
                  const qualityFinding = this.getSceneQualityFinding(part.sceneId);
                  if (!qualityFinding) {
                    return '';
                  }
                  return html`
                    <div
                      class="story-quality-badge"
                      data-state=${qualityFinding.status}
                    >
                      Quality: ${qualityFinding.status}
                      (${Math.round(qualityFinding.score * 100)}%)
                    </div>
                  `;
                })()}
                <div class="story-content">${part.content}</div>
                ${part.mediaType === 'audio'
                  ? html`
                      <div class="story-audio-controls">
                        <button
                          class="story-audio-button"
                          @click=${() => this.playVoiceoverPart(part)}
                          ?disabled=${this.speakingStoryPartKey === this.getStoryPartKey(part)}
                        >
                          ${this.speakingStoryPartKey === this.getStoryPartKey(part)
                            ? 'Playing'
                            : 'Play Voiceover'}
                        </button>
                        <button
                          class="story-audio-button"
                          @click=${this.stopVoiceoverPlayback}
                          ?disabled=${this.speakingStoryPartKey !== this.getStoryPartKey(part)}
                        >
                          Stop
                        </button>
                      </div>
                    `
                  : ''}
                ${part.mediaType === 'image' && part.data && part.mimeType
                  ? html`
                      <div class="story-media">
                        <img
                          src=${`data:${part.mimeType};base64,${part.data}`}
                          alt=${`Generated visual for ${part.sceneId}`}
                        >
                      </div>
                    `
                  : ''}
                ${part.mediaType === 'video' && part.url
                  ? html`
                      <div class="story-media">
                        <video controls src=${part.url}></video>
                      </div>
                    `
                  : ''}
              </div>
            `,
          )}
          ${this.storyQualityReport
            ? html`
                <div class="quality-summary">
                  Quality Score: ${Math.round(this.storyQualityReport.overallScore * 100)}%
                </div>
              `
            : ''}
          ${this.storySafetyReport
            ? html`
                <div
                  class="safety-summary"
                  data-state=${this.storySafetyReport.status}
                >
                  Safety: ${this.storySafetyReport.status}
                  (${this.storySafetyReport.issues.length} issues)
                </div>
                ${this.storySafetyReport.issues.slice(0, 3).map(
                  (issue) => html`
                    <div class="story-card">
                      <div class="story-kind">
                        ${issue.sceneId} · ${issue.category} · ${issue.severity}
                      </div>
                      <div class="story-content">${issue.reason}</div>
                    </div>
                  `,
                )}
              `
            : ''}
          ${this.storySummary
            ? html`<div class="summary-text">${this.storySummary}</div>`
            : ''}
          ${this.storyOutputPacks.map(
            (pack) => html`
              <div class="story-card">
                <div class="story-kind">${pack.format} pack</div>
                <div class="output-pack-title">${pack.title}</div>
                <div class="output-pack-content">${pack.content}</div>
                <div class="story-audio-controls">
                  <button
                    class="story-audio-button"
                    @click=${() => this.copyPackContent(pack)}
                  >
                    Copy Pack
                  </button>
                </div>
              </div>
            `,
          )}
        </div>

        <div class="controls">
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
          <div class="status-text">${this.error || this.status}</div>
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
