import type { RequirementProfile, StoryOutputPack, StoryPart } from '../protocol.js';

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, max = 220): string {
  const normalized = normalizeLine(value);
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeLine(value)).filter(Boolean)));
}

function groupSceneParts(parts: StoryPart[]) {
  const byScene = new Map<string, StoryPart[]>();
  for (const part of [...parts].sort((a, b) => a.sequence - b.sequence)) {
    const sceneParts = byScene.get(part.sceneId) ?? [];
    sceneParts.push(part);
    byScene.set(part.sceneId, sceneParts);
  }
  return Array.from(byScene.entries()).map(([sceneId, sceneParts]) => ({
    sceneId,
    sceneParts,
  }));
}

export function buildStoryOutputPacks(
  requirementProfile: RequirementProfile,
  storyParts: StoryPart[],
  summary: string,
): StoryOutputPack[] {
  const scenes = groupSceneParts(storyParts);
  const narrations = storyParts
    .filter((part) => part.kind === 'narration')
    .map((part) => normalizeLine(part.content));
  const voiceovers = storyParts
    .filter((part) => part.kind === 'voiceover')
    .map((part) => normalizeLine(part.content));
  const visualPrompts = storyParts
    .filter((part) => part.kind === 'image_prompt')
    .map((part) => clip(part.content, 180));
  const hashtags = uniqueValues(
    storyParts
      .filter((part) => part.kind === 'hashtags')
      .flatMap((part) => part.content.split(/\s+/)),
  ).map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/[^a-z0-9_]/gi, '')}`));

  const storybookContent = [
    `Title: ${clip(requirementProfile.objective, 100)}`,
    `Audience: ${requirementProfile.audience}`,
    `Tone/Style: ${requirementProfile.tone} / ${requirementProfile.style}`,
    '',
    `Summary: ${clip(summary || narrations[0] || 'A crafted story experience.', 280)}`,
    '',
    ...scenes.flatMap(({ sceneId, sceneParts }, index) => {
      const narration =
        sceneParts.find((part) => part.kind === 'narration')?.content ??
        'Narration pending.';
      const imagePrompt =
        sceneParts.find((part) => part.kind === 'image_prompt')?.content ??
        'Visual direction pending.';
      const voiceover =
        sceneParts.find((part) => part.kind === 'voiceover')?.content ??
        'Voiceover pending.';
      return [
        `Scene ${index + 1} (${sceneId})`,
        `- Narration: ${clip(narration, 260)}`,
        `- Illustration: ${clip(imagePrompt, 220)}`,
        `- Voiceover: ${clip(voiceover, 220)}`,
        '',
      ];
    }),
  ].join('\n');

  const marketingBullets = uniqueValues(
    visualPrompts.slice(0, 4).concat(narrations.slice(0, 2).map((line) => clip(line, 140))),
  );
  const marketingContent = [
    `Campaign Angle: ${clip(requirementProfile.objective, 130)}`,
    `Target Audience: ${requirementProfile.audience}`,
    `Brand Voice: ${requirementProfile.tone}`,
    '',
    'Primary Copy:',
    clip(summary || narrations.join(' ') || 'Launch-ready campaign narrative.', 320),
    '',
    'Asset Notes:',
    ...marketingBullets.map((item) => `- ${item}`),
    '',
    '30s Voice Script:',
    clip(voiceovers.join(' ') || narrations.join(' '), 320),
  ].join('\n');

  const mergedHashtags =
    hashtags.length > 0
      ? hashtags.slice(0, 12).join(' ')
      : '#CreativeStory #GeminiLive #Multimodal';
  const socialCaption = clip(
    `${narrations.slice(0, 2).join(' ')} ${summary}`.trim() ||
      'Fresh story drop. Immersive visuals, cinematic voice, and interactive flow.',
    320,
  );
  const socialContent = [
    socialCaption,
    '',
    `CTA: Tell us your next scene and we will regenerate instantly.`,
    mergedHashtags,
  ].join('\n');

  return [
    {
      format: 'storybook',
      title: 'Interactive Storybook Pack',
      content: storybookContent,
    },
    {
      format: 'marketing',
      title: 'Marketing Campaign Pack',
      content: marketingContent,
    },
    {
      format: 'social',
      title: 'Social Content Pack',
      content: socialContent,
    },
  ];
}
