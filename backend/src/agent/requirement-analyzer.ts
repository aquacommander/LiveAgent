import type { RequirementProfile } from '../protocol.js';

const objectivePatterns: Array<{ objective: string; pattern: RegExp }> = [
  { objective: 'Create a story', pattern: /\b(story|storybook|narrative|plot|chapter|character)\b/i },
  { objective: 'Create marketing content', pattern: /\b(marketing|campaign|ad copy|brand|promotion)\b/i },
  { objective: 'Create educational explainer', pattern: /\b(education|lesson|tutorial|teach|explain)\b/i },
  { objective: 'Create social content', pattern: /\b(social|instagram|tiktok|hashtags|caption)\b/i },
];

const tonePatterns: Array<{ tone: string; pattern: RegExp }> = [
  { tone: 'Cinematic', pattern: /\b(cinematic|epic|dramatic)\b/i },
  { tone: 'Playful', pattern: /\b(fun|playful|light|humor|funny)\b/i },
  { tone: 'Professional', pattern: /\b(professional|formal|business)\b/i },
  { tone: 'Emotional', pattern: /\b(emotional|heartwarming|inspiring)\b/i },
];

const audiencePatterns: Array<{ audience: string; pattern: RegExp }> = [
  { audience: 'Kids', pattern: /\b(kid|kids|children)\b/i },
  { audience: 'Teenagers', pattern: /\b(teen|teens|teenager)\b/i },
  { audience: 'General audience', pattern: /\b(everyone|general audience|all ages)\b/i },
  { audience: 'Professionals', pattern: /\b(executive|professional|enterprise|business users)\b/i },
];

function extractConstraints(text: string): string[] {
  const constraints: string[] = [];
  const mustIncludeMatches = text.match(/must include ([^.,;]+)/gi) ?? [];
  for (const match of mustIncludeMatches) {
    constraints.push(match.trim());
  }
  const avoidMatches = text.match(/(avoid|do not|don't) ([^.,;]+)/gi) ?? [];
  for (const match of avoidMatches) {
    constraints.push(match.trim());
  }
  return constraints;
}

export function analyzeRequirements(
  transcript: string,
  previous: RequirementProfile | null,
): RequirementProfile {
  const text = transcript.trim();
  const objective =
    objectivePatterns.find((entry) => entry.pattern.test(text))?.objective ??
    previous?.objective ??
    'Requirement discovery conversation';
  const tone =
    tonePatterns.find((entry) => entry.pattern.test(text))?.tone ??
    previous?.tone ??
    'Not specified';
  const audience =
    audiencePatterns.find((entry) => entry.pattern.test(text))?.audience ??
    previous?.audience ??
    'Not specified';
  const styleMatch = text.match(/\b(style|visual style|look|aesthetic)\b[:\s-]*([^.,;]+)/i);
  const style = styleMatch?.[2]?.trim() ?? previous?.style ?? 'Not specified';

  const constraints = Array.from(
    new Set([...(previous?.constraints ?? []), ...extractConstraints(text)]),
  );

  const missingInformation: string[] = [];
  if (audience === 'Not specified') missingInformation.push('Target audience');
  if (tone === 'Not specified') missingInformation.push('Tone');
  if (style === 'Not specified') missingInformation.push('Visual style');

  let confidence = 0.45;
  if (objective !== 'Requirement discovery conversation') confidence += 0.2;
  if (audience !== 'Not specified') confidence += 0.15;
  if (tone !== 'Not specified') confidence += 0.1;
  if (style !== 'Not specified') confidence += 0.1;
  confidence = Math.min(confidence, 0.98);

  return {
    objective,
    audience,
    tone,
    style,
    constraints,
    missingInformation,
    confidence,
  };
}

export function shouldEnterStoryMode(profile: RequirementProfile): boolean {
  return profile.objective.toLowerCase().includes('story') && profile.confidence >= 0.65;
}
