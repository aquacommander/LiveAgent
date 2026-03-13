import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
} from '@google/genai';
import { config } from './config.js';
import type {
  AgentMode,
  ClientToServerMessage,
  RequirementProfile,
  ServerToClientMessage,
  StoryPart,
} from './protocol.js';
import {
  analyzeRequirements,
  shouldEnterStoryMode,
} from './agent/requirement-analyzer.js';
import {
  generateCreativeStoryParts,
  reviseCreativeStoryScenes,
} from './story/creative-storyteller.js';
import { buildStoryOutputPacks } from './story/output-packs.js';
import { applySafetyGuardrails, runStorySafetyChecks } from './story/safety-check.js';
import { emitStoryTelemetry } from './telemetry/story-telemetry.js';
import { randomUUID } from 'node:crypto';

const mediaStore = new Map<
  string,
  { bytes: Uint8Array; mimeType: string; createdAt: number }
>();

function persistMedia(bytes: Uint8Array, mimeType: string): string {
  const id = randomUUID();
  mediaStore.set(id, { bytes, mimeType, createdAt: Date.now() });
  return `/media/${id}`;
}

function cleanupMediaStore(maxAgeMs = 20 * 60 * 1000): void {
  const now = Date.now();
  for (const [id, item] of mediaStore.entries()) {
    if (now - item.createdAt > maxAgeMs) {
      mediaStore.delete(id);
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/media/:id', (req, res) => {
  const item = mediaStore.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Media not found.' });
    return;
  }
  res.setHeader('Content-Type', item.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(item.bytes));
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/live',
});

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function extractText(message: LiveServerMessage): string | null {
  const parts = message.serverContent?.modelTurn?.parts;
  if (!parts?.length) {
    return null;
  }
  const textParts = parts
    .map((part) => part.text ?? '')
    .filter((part) => part.length > 0);
  if (!textParts.length) {
    return null;
  }
  return textParts.join('\n');
}

function extractUserTranscript(message: LiveServerMessage): string | null {
  const unsafe = message as unknown as {
    serverContent?: {
      inputTranscription?: { text?: string };
      inputTranscript?: { text?: string };
      userText?: string;
    };
  };

  const transcript =
    unsafe.serverContent?.inputTranscription?.text ??
    unsafe.serverContent?.inputTranscript?.text ??
    unsafe.serverContent?.userText;

  if (!transcript || !transcript.trim()) {
    return null;
  }
  return transcript.trim();
}

function extractAudio(message: LiveServerMessage): {
  data: string;
  mimeType: string;
} | null {
  const parts = message.serverContent?.modelTurn?.parts;
  if (!parts?.length) {
    return null;
  }
  const inlineData = parts.find((part) => !!part.inlineData)?.inlineData;
  if (!inlineData?.data || !inlineData?.mimeType) {
    return null;
  }
  return {
    data: inlineData.data,
    mimeType: inlineData.mimeType,
  };
}

wss.on('connection', (socket) => {
  const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  let session: Session | null = null;
  let requirementProfile: RequirementProfile | null = null;
  let previousRequirementProfile: RequirementProfile | null = null;
  let latestStoryParts: StoryPart[] = [];
  let agentMode: AgentMode = 'conversation';
  let lastAnalyzedUserText = '';
  let isStoryGenerationRunning = false;
  let queuedRequirementUpdate: string | null = null;
  let isSessionStarting = false;
  let isSessionReady = false;
  const pendingInputs: Array<
    Extract<ClientToServerMessage, { type: 'input_audio' | 'input_image' | 'input_text' }>
  > = [];

  const inferAffectedSceneIds = (text: string, parts: StoryPart[]): string[] => {
    const sceneIds = Array.from(new Set(parts.map((part) => part.sceneId))).sort();
    if (sceneIds.length === 0) {
      return [];
    }

    const normalized = text.toLowerCase();
    const explicitSceneMatch = normalized.match(/scene\s*(\d+)/i);
    if (explicitSceneMatch) {
      const target = `scene-${explicitSceneMatch[1]}`;
      if (sceneIds.includes(target)) {
        return [target];
      }
    }

    if (/\b(first|opening|intro|beginning)\b/i.test(normalized)) {
      return [sceneIds[0]];
    }
    if (/\b(last|ending|final|conclusion)\b/i.test(normalized)) {
      return [sceneIds[sceneIds.length - 1]];
    }
    if (/\b(tone|style|audience|overall|entire|whole|all scenes)\b/i.test(normalized)) {
      return sceneIds;
    }

    return [sceneIds[sceneIds.length - 1]];
  };

  const applyRevisedScenes = (currentParts: StoryPart[], revisedParts: StoryPart[]) => {
    const revisedScenes = new Set(revisedParts.map((part) => part.sceneId));
    const preserved = currentParts.filter((part) => !revisedScenes.has(part.sceneId));
    return [...preserved, ...revisedParts].sort((a, b) => a.sequence - b.sequence);
  };

  const runStoryGeneration = async (
    text: string,
    mode: 'initial' | 'revision',
    targetSceneIds: string[] = [],
  ): Promise<void> => {
    if (!requirementProfile) {
      return;
    }
    isStoryGenerationRunning = true;
    emitStoryTelemetry('generation_started', {
      mode,
      targetSceneIds,
      hasPreviousStory: latestStoryParts.length > 0,
    });
    try {
      if (mode === 'revision' && latestStoryParts.length > 0) {
        const revision = await reviseCreativeStoryScenes(
          client,
          requirementProfile,
          text,
          latestStoryParts,
          targetSceneIds,
          {
            persistVideo: async (bytes, mimeType) => {
              cleanupMediaStore();
              return persistMedia(bytes, mimeType);
            },
            emitRenderStatus: (sceneId, status, message) => {
              send(socket, {
                type: 'story_render_status',
                payload: { sceneId, status, message },
              });
            },
          },
        );

        const normalizedRevisedParts = revision.revisedParts.map((part) =>
          part.url && part.url.startsWith('/')
            ? { ...part, url: `http://localhost:${config.port}${part.url}` }
            : part,
        );
        const mergedParts = applyRevisedScenes(latestStoryParts, normalizedRevisedParts);
        const safetyReport = runStorySafetyChecks(requirementProfile, mergedParts);
        latestStoryParts = applySafetyGuardrails(mergedParts, safetyReport);

        for (const sceneId of new Set(latestStoryParts.map((part) => part.sceneId))) {
          send(socket, {
            type: 'story_scene_revised',
            payload: {
              sceneId,
              reason: 'User updated requirements during storytelling.',
              parts: latestStoryParts.filter((part) => part.sceneId === sceneId),
            },
          });
        }
        send(socket, {
          type: 'story_quality_report',
          payload: { report: revision.qualityReport },
        });
        send(socket, {
          type: 'story_safety_report',
          payload: { report: safetyReport },
        });
        if (safetyReport.status !== 'safe') {
          emitStoryTelemetry('safety_flagged', {
            mode: 'revision',
            status: safetyReport.status,
            issueCount: safetyReport.issues.length,
          });
        }
        send(socket, {
          type: 'story_output_packs',
          payload: {
            packs: buildStoryOutputPacks(
              requirementProfile,
              latestStoryParts,
              'Scene revision applied.',
            ),
          },
        });
        send(socket, {
          type: 'story_generation_done',
          payload: { summary: 'Scene revision applied.' },
        });
        emitStoryTelemetry('generation_completed', {
          mode: 'revision',
          safetyStatus: safetyReport.status,
          issueCount: safetyReport.issues.length,
          partCount: latestStoryParts.length,
        });
        return;
      }

      const story = await generateCreativeStoryParts(client, requirementProfile, text, {
        persistVideo: async (bytes, mimeType) => {
          cleanupMediaStore();
          return persistMedia(bytes, mimeType);
        },
        emitRenderStatus: (sceneId, status, message) => {
          send(socket, {
            type: 'story_render_status',
            payload: {
              sceneId,
              status,
              message,
            },
          });
        },
      });

      const normalizedGeneratedParts = story.parts.map((part) =>
        part.url && part.url.startsWith('/')
          ? { ...part, url: `http://localhost:${config.port}${part.url}` }
          : part,
      );
      const safetyReport = runStorySafetyChecks(
        requirementProfile,
        normalizedGeneratedParts,
      );
      latestStoryParts = applySafetyGuardrails(normalizedGeneratedParts, safetyReport);
      for (const part of latestStoryParts) {
        send(socket, {
          type: 'story_part',
          payload: part,
        });
      }
      send(socket, {
        type: 'story_quality_report',
        payload: { report: story.qualityReport },
      });
      send(socket, {
        type: 'story_safety_report',
        payload: { report: safetyReport },
      });
      if (safetyReport.status !== 'safe') {
        emitStoryTelemetry('safety_flagged', {
          mode: 'initial',
          status: safetyReport.status,
          issueCount: safetyReport.issues.length,
        });
      }
      send(socket, {
        type: 'story_output_packs',
        payload: {
          packs: buildStoryOutputPacks(
            requirementProfile,
            latestStoryParts,
            story.summary,
          ),
        },
      });
      send(socket, {
        type: 'story_generation_done',
        payload: { summary: story.summary },
      });
      emitStoryTelemetry('generation_completed', {
        mode: 'initial',
        safetyStatus: safetyReport.status,
        issueCount: safetyReport.issues.length,
        partCount: latestStoryParts.length,
      });
    } catch (error) {
      emitStoryTelemetry('generation_failed', {
        mode,
        message:
          error instanceof Error ? error.message : 'Creative storyteller generation failed.',
      });
      send(socket, {
        type: 'error',
        payload: {
          message:
            error instanceof Error
              ? error.message
              : 'Creative storyteller generation failed.',
        },
      });
    } finally {
      isStoryGenerationRunning = false;
      if (queuedRequirementUpdate) {
        const queued = queuedRequirementUpdate;
        queuedRequirementUpdate = null;
        await processRequirementText(queued);
      }
    }
  };

  const processRequirementText = async (text: string): Promise<void> => {
    const normalized = text.trim().toLowerCase();
    if (normalized && normalized !== lastAnalyzedUserText) {
      lastAnalyzedUserText = normalized;
      previousRequirementProfile = requirementProfile;
      requirementProfile = analyzeRequirements(text, requirementProfile);
      send(socket, {
        type: 'requirement_profile_updated',
        payload: { profile: requirementProfile },
      });

      if (shouldEnterStoryMode(requirementProfile)) {
        if (agentMode !== 'creative_storyteller') {
          agentMode = 'creative_storyteller';
          send(socket, {
            type: 'mode_changed',
            payload: {
              mode: agentMode,
              reason: 'Story intent detected from user requirements.',
            },
          });
        }

        if (isStoryGenerationRunning) {
          queuedRequirementUpdate = text;
          send(socket, {
            type: 'status',
            payload: {
              message:
                'Update captured. Applying scene revision after current generation.',
            },
          });
          return;
        }

        const hasPreviousStory = latestStoryParts.length > 0;
        const changedCoreFields =
          !!previousRequirementProfile &&
          (previousRequirementProfile.objective !== requirementProfile.objective ||
            previousRequirementProfile.audience !== requirementProfile.audience ||
            previousRequirementProfile.tone !== requirementProfile.tone ||
            previousRequirementProfile.style !== requirementProfile.style ||
            previousRequirementProfile.constraints.join('|') !==
              requirementProfile.constraints.join('|'));
        const userRequestedRevision = /\b(scene|revise|update|change|replace|ending|intro)\b/i.test(
          text,
        );

        if (hasPreviousStory && (changedCoreFields || userRequestedRevision)) {
          const affectedSceneIds = inferAffectedSceneIds(text, latestStoryParts);
          await runStoryGeneration(text, 'revision', affectedSceneIds);
        } else {
          await runStoryGeneration(text, 'initial');
        }
      } else {
        if (agentMode !== 'conversation') {
          agentMode = 'conversation';
          send(socket, {
            type: 'mode_changed',
            payload: {
              mode: agentMode,
              reason: 'Continuing requirement discovery conversation.',
            },
          });
        }
        if (requirementProfile.missingInformation.length > 0) {
          const missing = requirementProfile.missingInformation[0];
          send(socket, {
            type: 'clarification_question',
            payload: {
              question: `To better help you, what is your preferred ${missing.toLowerCase()}?`,
            },
          });
        }
      }
    }
  };

  const forwardInput = async (
    inputMessage: Extract<
      ClientToServerMessage,
      { type: 'input_audio' | 'input_image' | 'input_text' }
    >,
  ): Promise<void> => {
    if (!session) {
      throw new Error('No active live session.');
    }

    if (inputMessage.type === 'input_audio' || inputMessage.type === 'input_image') {
      await session.sendRealtimeInput({
        media: {
          data: inputMessage.payload.data,
          mimeType: inputMessage.payload.mimeType,
        },
      });
      return;
    }

    const text = inputMessage.payload.text;
    await session.sendRealtimeInput({ text });
    await processRequirementText(text);
  };

  send(socket, {
    type: 'status',
    payload: { message: 'Connected to backend.' },
  });
  send(socket, {
    type: 'mode_changed',
    payload: {
      mode: 'conversation',
      reason: 'Default mode: requirement discovery.',
    },
  });

  socket.on('message', async (rawData: Buffer) => {
    let message: ClientToServerMessage;

    try {
      message = JSON.parse(rawData.toString()) as ClientToServerMessage;
    } catch (error) {
      send(socket, {
        type: 'error',
        payload: {
          message:
            error instanceof Error
              ? error.message
              : 'Invalid JSON message from client.',
        },
      });
      return;
    }

    try {
      if (message.type === 'start_session') {
        if (session) {
          await session.close();
          session = null;
        }
        pendingInputs.length = 0;
        latestStoryParts = [];
        queuedRequirementUpdate = null;
        previousRequirementProfile = null;
        requirementProfile = null;
        lastAnalyzedUserText = '';
        agentMode = 'conversation';
        isSessionReady = false;
        isSessionStarting = true;
        send(socket, {
          type: 'status',
          payload: { message: 'Starting live session...' },
        });
        emitStoryTelemetry('session_starting', { agentMode });

        const model = message.payload?.model ?? config.defaultModel;
        const voiceName = message.payload?.voiceName ?? config.defaultVoice;
        const requestedModalities = message.payload?.responseModalities ?? [
          'AUDIO',
        ];

        const responseModalities =
          requestedModalities.includes('TEXT') && requestedModalities.includes('AUDIO')
            ? [Modality.TEXT, Modality.AUDIO]
            : requestedModalities.includes('TEXT')
              ? [Modality.TEXT]
              : [Modality.AUDIO];

        session = await client.live.connect({
          model,
          callbacks: {
            onopen: () => {
              isSessionStarting = false;
              isSessionReady = true;
              send(socket, {
                type: 'session_ready',
                payload: { message: 'Gemini Live session opened.' },
              });
              void (async () => {
                while (pendingInputs.length) {
                  const queuedInput = pendingInputs.shift();
                  if (!queuedInput) {
                    break;
                  }
                  await forwardInput(queuedInput);
                }
              })();
            },
            onmessage: (liveMessage: LiveServerMessage) => {
              const userTranscript = extractUserTranscript(liveMessage);
              if (
                userTranscript &&
                userTranscript.toLowerCase() !== lastAnalyzedUserText
              ) {
                void processRequirementText(userTranscript);
              }

              const audio = extractAudio(liveMessage);
              if (audio) {
                send(socket, {
                  type: 'model_audio',
                  payload: audio,
                });
              }

              const text = extractText(liveMessage);
              if (text) {
                send(socket, {
                  type: 'model_text',
                  payload: { text },
                });
              }

              if (liveMessage.serverContent?.interrupted) {
                send(socket, { type: 'interrupted' });
              }
            },
            onerror: (event: { message?: string }) => {
              send(socket, {
                type: 'error',
                payload: { message: event.message ?? 'Gemini session error.' },
              });
            },
            onclose: (event: { reason?: string }) => {
              isSessionReady = false;
              isSessionStarting = false;
              send(socket, {
                type: 'status',
                payload: {
                  message: `Gemini session closed: ${event.reason ?? 'no reason'}`,
                },
              });
            },
          },
          config: {
            responseModalities,
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
        });

        return;
      }

      if (
        message.type === 'input_audio' ||
        message.type === 'input_image' ||
        message.type === 'input_text'
      ) {
        if (isSessionStarting && !isSessionReady) {
          pendingInputs.push(message);
          return;
        }

        if (!session || !isSessionReady) {
          send(socket, {
            type: 'error',
            payload: { message: 'Session is not ready yet. Please retry.' },
          });
          return;
        }

        await forwardInput(message);
        return;
      }

      if (!session) {
        send(socket, {
          type: 'error',
          payload: { message: 'No live session. Send start_session first.' },
        });
        return;
      }

      if (message.type === 'end_session') {
        await session.close();
        session = null;
        isSessionReady = false;
        isSessionStarting = false;
        pendingInputs.length = 0;
        latestStoryParts = [];
        queuedRequirementUpdate = null;
        previousRequirementProfile = null;
        requirementProfile = null;
        lastAnalyzedUserText = '';
        agentMode = 'conversation';
        send(socket, {
          type: 'status',
          payload: { message: 'Session ended.' },
        });
        emitStoryTelemetry('session_ended', { agentMode: 'conversation' });
      }
    } catch (error) {
      send(socket, {
        type: 'error',
        payload: {
          message:
            error instanceof Error ? error.message : 'Unexpected server error.',
        },
      });
    }
  });

  socket.on('close', async () => {
    if (session) {
      await session.close();
      session = null;
    }
  });
});

server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Live backend listening on http://localhost:${config.port}`);
});
