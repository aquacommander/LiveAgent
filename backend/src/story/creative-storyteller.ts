import { GoogleGenAI } from '@google/genai';
import type {
  RequirementProfile,
  StoryPart,
  StoryQualityReport,
} from '../protocol.js';
import { config } from '../config.js';
import { runStoryQualityGate } from './quality-gate.js';

type RenderStatusEmitter = (
  sceneId: string,
  status: 'queued' | 'rendering' | 'ready' | 'failed',
  message: string,
) => void;

type StoryGenerationOptions = {
  persistVideo?: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  emitRenderStatus?: RenderStatusEmitter;
};

const INLINE_IMAGE_CACHE = new Map<string, { data: string; mimeType: string }>();
const VOICEOVER_AUDIO_CACHE = new Map<string, { data: string; mimeType: string }>();
const MAX_CACHE_ENTRIES = 40;

function setCached<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
}

async function generateInlineImage(
  ai: GoogleGenAI,
  prompt: string,
): Promise<{ data: string; mimeType: string } | null> {
  const cached = INLINE_IMAGE_CACHE.get(prompt);
  if (cached) {
    return cached;
  }
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-preview-image-generation',
      contents: prompt,
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith('image/')) {
        const result = {
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        };
        setCached(INLINE_IMAGE_CACHE, prompt, result);
        return result;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function generateVoiceoverAudio(
  ai: GoogleGenAI,
  text: string,
): Promise<{ data: string; mimeType: string } | null> {
  const cached = VOICEOVER_AUDIO_CACHE.get(text);
  if (cached) {
    return cached;
  }
  // We attempt TTS with a dedicated audio-capable model first.
  const attempts: Array<() => Promise<unknown>> = [
    async () =>
      (ai.models as any).generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: text,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: config.defaultVoice },
            },
          },
        },
      }),
    async () =>
      (ai.models as any).generateContent({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        contents: text,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: config.defaultVoice },
            },
          },
        },
      }),
  ];

  for (const run of attempts) {
    try {
      const response = (await run()) as any;
      const parts = response?.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inline = part?.inlineData;
        if (
          inline?.data &&
          typeof inline?.mimeType === 'string' &&
          inline.mimeType.startsWith('audio/')
        ) {
          const result = {
            data: inline.data,
            mimeType: inline.mimeType,
          };
          setCached(VOICEOVER_AUDIO_CACHE, text, result);
          return result;
        }
      }
    } catch {
      // Try next model attempt.
    }
  }

  return null;
}

async function pollVideoOperation(
  ai: GoogleGenAI,
  operation: any,
  maxWaitMs = 180000,
): Promise<any> {
  const startTime = Date.now();
  let current = operation;

  while (!current?.done) {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error('Video generation timed out.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    current = await (ai.operations as any).getVideosOperation({ operation: current });
  }

  return current;
}

async function fetchVideoBytes(uri: string): Promise<Uint8Array> {
  const url = new URL(uri);
  url.searchParams.append('key', config.geminiApiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch generated video: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

async function generateStoryboardVideo(
  ai: GoogleGenAI,
  prompt: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const operation = await (ai.models as any).generateVideos({
      model: 'veo-3.1-fast-generate-preview',
      prompt,
      config: {
        numberOfVideos: 1,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    });

    const completed = await pollVideoOperation(ai, operation);
    const uri = completed?.response?.generatedVideos?.[0]?.video?.uri;
    if (!uri) {
      return null;
    }

    const bytes = await fetchVideoBytes(uri);
    return { bytes, mimeType: 'video/mp4' };
  } catch {
    return null;
  }
}

async function enrichPartsWithMedia(
  ai: GoogleGenAI,
  requirementProfile: RequirementProfile,
  parts: StoryPart[],
  options: StoryGenerationOptions,
): Promise<StoryPart[]> {
  for (const part of parts) {
    if (part.kind === 'voiceover') {
      const voiceoverAudio = await generateVoiceoverAudio(ai, part.content);
      if (voiceoverAudio) {
        part.mediaType = 'audio';
        part.mimeType = voiceoverAudio.mimeType;
        part.data = voiceoverAudio.data;
      }
      continue;
    }

    if (part.kind === 'storyboard' && options.persistVideo) {
      options.emitRenderStatus?.(
        part.sceneId,
        'queued',
        'Storyboard video is queued for rendering.',
      );
      options.emitRenderStatus?.(
        part.sceneId,
        'rendering',
        'Rendering storyboard video clip...',
      );

      const videoPrompt = [
        `Create a cinematic short scene video for ${part.sceneId}.`,
        `Audience: ${requirementProfile.audience}. Tone: ${requirementProfile.tone}.`,
        `Style: ${requirementProfile.style}.`,
        `Storyboard details: ${part.content}`,
      ].join(' ');

      const generatedVideo = await generateStoryboardVideo(ai, videoPrompt);
      if (generatedVideo) {
        const url = await options.persistVideo(
          generatedVideo.bytes,
          generatedVideo.mimeType,
        );
        part.mediaType = 'video';
        part.mimeType = generatedVideo.mimeType;
        part.url = url;
        options.emitRenderStatus?.(
          part.sceneId,
          'ready',
          'Storyboard video clip is ready.',
        );
      } else {
        options.emitRenderStatus?.(
          part.sceneId,
          'failed',
          'Storyboard video rendering failed. Text storyboard kept.',
        );
      }
      continue;
    }

    if (part.kind !== 'image_prompt') {
      continue;
    }

    const visualPrompt = [
      `Create a cinematic high quality image for scene ${part.sceneId}.`,
      `Audience: ${requirementProfile.audience}. Tone: ${requirementProfile.tone}.`,
      `Style: ${requirementProfile.style}.`,
      `Scene content: ${part.content}`,
      'No text overlay.',
    ].join(' ');

    const image = await generateInlineImage(ai, visualPrompt);
    if (image) {
      part.mediaType = 'image';
      part.mimeType = image.mimeType;
      part.data = image.data;
    }
  }

  return parts;
}

export async function generateCreativeStoryParts(
  ai: GoogleGenAI,
  requirementProfile: RequirementProfile,
  userRequest: string,
  options: StoryGenerationOptions = {},
): Promise<{ parts: StoryPart[]; summary: string; qualityReport: StoryQualityReport }> {
  const prompt = `
You are a Creative Storyteller. Generate interleaved multimodal story output.
Return strict JSON only with this shape:
{
  "summary": "string",
  "parts": [
    { "sceneId": "scene-1", "kind": "narration", "content": "..." },
    { "sceneId": "scene-1", "kind": "image_prompt", "content": "..." },
    { "sceneId": "scene-1", "kind": "voiceover", "content": "..." },
    { "sceneId": "scene-1", "kind": "storyboard", "content": "..." },
    { "sceneId": "scene-1", "kind": "hashtags", "content": "..." }
  ]
}

Constraints:
- Objective: ${requirementProfile.objective}
- Audience: ${requirementProfile.audience}
- Tone: ${requirementProfile.tone}
- Style: ${requirementProfile.style}
- Additional constraints: ${requirementProfile.constraints.join('; ') || 'None'}
- User request: ${userRequest}

Rules:
- 2 scenes only
- Keep each content concise and production-ready.
- Make the image_prompt highly visual and specific.
- Keep hashtags relevant and short.
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
    },
  });

  const raw = response.text?.trim() ?? '{}';
  let parsed: {
    summary?: string;
    parts?: Array<{ sceneId?: string; kind?: string; content?: string }>;
  };

  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    parsed = {
      summary: 'Story generated in fallback mode.',
      parts: [
        {
          sceneId: 'scene-1',
          kind: 'narration',
          content: 'A cinematic opening scene introduces the core story conflict.',
        },
        {
          sceneId: 'scene-1',
          kind: 'image_prompt',
          content:
            'Wide cinematic shot, dramatic key light, atmospheric haze, protagonist centered.',
        },
        {
          sceneId: 'scene-1',
          kind: 'voiceover',
          content:
            'In a world shaped by choices, one voice rises to change everything.',
        },
      ],
    };
  }

  const safeKinds = new Set([
    'narration',
    'image_prompt',
    'voiceover',
    'storyboard',
    'hashtags',
  ]);

  const initialParts: StoryPart[] = (parsed.parts ?? [])
    .filter((part) => typeof part.content === 'string' && !!part.content?.trim())
    .map((part, index) => ({
      sequence: index + 1,
      sceneId: part.sceneId ?? `scene-${Math.floor(index / 5) + 1}`,
      kind: safeKinds.has(part.kind ?? '') ? (part.kind as StoryPart['kind']) : 'narration',
      content: part.content ?? '',
      mediaType: part.kind === 'voiceover' ? 'audio' : 'text',
    }));

  const qualityGate = await runStoryQualityGate(
    ai,
    requirementProfile,
    initialParts,
  );
  const parts = await enrichPartsWithMedia(
    ai,
    requirementProfile,
    qualityGate.parts,
    options,
  );

  return {
    parts,
    summary: parsed.summary ?? 'Story generation complete.',
    qualityReport: qualityGate.report,
  };
}

export async function reviseCreativeStoryScenes(
  ai: GoogleGenAI,
  requirementProfile: RequirementProfile,
  userUpdate: string,
  existingParts: StoryPart[],
  targetSceneIds: string[],
  options: StoryGenerationOptions = {},
): Promise<{ revisedParts: StoryPart[]; qualityReport: StoryQualityReport }> {
  const targetSet = new Set(targetSceneIds);
  const targetScenes = Array.from(targetSet)
    .map((sceneId) => ({
      sceneId,
      parts: existingParts
        .filter((part) => part.sceneId === sceneId)
        .map((part) => ({ kind: part.kind, content: part.content })),
    }))
    .filter((scene) => scene.parts.length > 0);

  if (targetScenes.length === 0) {
    return {
      revisedParts: [],
      qualityReport: { overallScore: 0.8, findings: [] },
    };
  }

  const prompt = `
You are a creative director revising only selected scenes.
Return JSON only:
{
  "scenes": [
    {
      "sceneId": "scene-1",
      "parts": [
        { "kind": "narration", "content": "..." },
        { "kind": "image_prompt", "content": "..." },
        { "kind": "voiceover", "content": "..." },
        { "kind": "storyboard", "content": "..." },
        { "kind": "hashtags", "content": "..." }
      ]
    }
  ]
}

Requirement Profile:
- Objective: ${requirementProfile.objective}
- Audience: ${requirementProfile.audience}
- Tone: ${requirementProfile.tone}
- Style: ${requirementProfile.style}
- Constraints: ${requirementProfile.constraints.join('; ') || 'None'}

User update:
${userUpdate}

Scenes to revise:
${JSON.stringify(targetScenes)}

Rules:
- Revise ONLY the provided scenes.
- Keep kind names unchanged.
- Keep output concise and production-ready.
`;

  let parsedScenes: Array<{
    sceneId?: string;
    parts?: Array<{ kind?: string; content?: string }>;
  }> = [];
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text?.trim() ?? '{}') as {
      scenes?: Array<{
        sceneId?: string;
        parts?: Array<{ kind?: string; content?: string }>;
      }>;
    };
    parsedScenes = parsed.scenes ?? [];
  } catch {
    parsedScenes = targetScenes;
  }

  const revisedParts: StoryPart[] = [];
  for (const scene of parsedScenes) {
    const sceneId = scene.sceneId ?? '';
    if (!sceneId || !targetSet.has(sceneId)) {
      continue;
    }

    const referenceParts = existingParts
      .filter((part) => part.sceneId === sceneId)
      .sort((a, b) => a.sequence - b.sequence);
    const fallbackKinds = referenceParts.map((part) => part.kind);
    const sourceParts = (scene.parts ?? []).length > 0 ? scene.parts ?? [] : referenceParts;

    for (const sourcePart of sourceParts) {
      const kind = (sourcePart.kind ??
        fallbackKinds[0] ??
        'narration') as StoryPart['kind'];
      const matchedReference = referenceParts.find((part) => part.kind === kind);
      revisedParts.push({
        sequence:
          matchedReference?.sequence ??
          (referenceParts[referenceParts.length - 1]?.sequence ?? 0) + revisedParts.length + 1,
        sceneId,
        kind,
        content:
          typeof sourcePart.content === 'string' && sourcePart.content.trim().length > 0
            ? sourcePart.content.trim()
            : matchedReference?.content ?? '',
        mediaType: kind === 'voiceover' ? 'audio' : 'text',
      });
    }
  }

  const qualityGate = await runStoryQualityGate(
    ai,
    requirementProfile,
    revisedParts,
  );
  const enrichedParts = await enrichPartsWithMedia(
    ai,
    requirementProfile,
    qualityGate.parts,
    options,
  );

  return {
    revisedParts: enrichedParts,
    qualityReport: qualityGate.report,
  };
}
