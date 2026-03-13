import { GoogleGenAI } from '@google/genai';
import type { RequirementProfile, StoryPart } from '../protocol.js';

export async function generateCreativeStoryParts(
  ai: GoogleGenAI,
  requirementProfile: RequirementProfile,
  userRequest: string,
): Promise<{ parts: StoryPart[]; summary: string }> {
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

  const parts: StoryPart[] = (parsed.parts ?? [])
    .filter((part) => typeof part.content === 'string' && !!part.content?.trim())
    .map((part, index) => ({
      sequence: index + 1,
      sceneId: part.sceneId ?? `scene-${Math.floor(index / 5) + 1}`,
      kind: safeKinds.has(part.kind ?? '') ? (part.kind as StoryPart['kind']) : 'narration',
      content: part.content ?? '',
    }));

  return {
    parts,
    summary: parsed.summary ?? 'Story generation complete.',
  };
}
