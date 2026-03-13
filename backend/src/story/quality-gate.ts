import { GoogleGenAI } from '@google/genai';
import type {
  RequirementProfile,
  StoryPart,
  StoryQualityFinding,
  StoryQualityReport,
} from '../protocol.js';

type SceneEvaluation = {
  score: number;
  status: 'passed' | 'revised' | 'failed';
  issues: string[];
  revisedParts: Array<{ kind: string; content: string }>;
};

async function evaluateSceneQuality(
  ai: GoogleGenAI,
  sceneId: string,
  parts: StoryPart[],
  requirementProfile: RequirementProfile,
): Promise<SceneEvaluation> {
  const partsForPrompt = parts.map((part) => ({
    kind: part.kind,
    content: part.content,
  }));

  const prompt = `
You are a strict creative-director quality gate.
Evaluate this scene against the requirement profile and optionally revise weak parts.
Return JSON only:
{
  "score": 0.0 to 1.0,
  "status": "passed" | "revised" | "failed",
  "issues": ["..."],
  "revisedParts": [{ "kind": "narration", "content": "..." }]
}

Scene ID: ${sceneId}
Requirement Profile:
- Objective: ${requirementProfile.objective}
- Audience: ${requirementProfile.audience}
- Tone: ${requirementProfile.tone}
- Style: ${requirementProfile.style}
- Constraints: ${requirementProfile.constraints.join('; ') || 'None'}

Scene Parts:
${JSON.stringify(partsForPrompt)}

Rules:
- If scene clearly aligns, status must be "passed" and revisedParts must be [].
- If partially aligned, status "revised" and include only revised parts that should replace originals.
- If severely off-target, status "failed".
- Keep revised content concise and production-ready.
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });
    const parsed = JSON.parse(response.text?.trim() ?? '{}') as Partial<SceneEvaluation>;
    return {
      score:
        typeof parsed.score === 'number'
          ? Math.max(0, Math.min(1, parsed.score))
          : 0.72,
      status:
        parsed.status === 'passed' || parsed.status === 'revised' || parsed.status === 'failed'
          ? parsed.status
          : 'revised',
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((item): item is string => typeof item === 'string')
        : ['Alignment required additional review.'],
      revisedParts: Array.isArray(parsed.revisedParts)
        ? parsed.revisedParts
            .filter(
              (item): item is { kind: string; content: string } =>
                !!item &&
                typeof item.kind === 'string' &&
                typeof item.content === 'string' &&
                item.content.trim().length > 0,
            )
            .map((item) => ({ kind: item.kind, content: item.content.trim() }))
        : [],
    };
  } catch {
    return {
      score: 0.65,
      status: 'failed',
      issues: ['Quality gate evaluation failed; kept original scene.'],
      revisedParts: [],
    };
  }
}

export async function runStoryQualityGate(
  ai: GoogleGenAI,
  requirementProfile: RequirementProfile,
  parts: StoryPart[],
): Promise<{ parts: StoryPart[]; report: StoryQualityReport }> {
  const updatedParts = [...parts];
  const sceneIds = Array.from(new Set(updatedParts.map((part) => part.sceneId)));
  const findings: StoryQualityFinding[] = [];

  for (const sceneId of sceneIds) {
    const sceneParts = updatedParts.filter((part) => part.sceneId === sceneId);
    const evaluation = await evaluateSceneQuality(
      ai,
      sceneId,
      sceneParts,
      requirementProfile,
    );

    if (evaluation.status === 'revised' && evaluation.revisedParts.length > 0) {
      for (const revision of evaluation.revisedParts) {
        const target = updatedParts.find(
          (part) => part.sceneId === sceneId && part.kind === revision.kind,
        );
        if (target) {
          target.content = revision.content;
        }
      }
    }

    findings.push({
      sceneId,
      score: Number(evaluation.score.toFixed(2)),
      status: evaluation.status,
      issues: evaluation.issues,
      revisedKinds: evaluation.revisedParts.map((item) => item.kind),
    });
  }

  const overallScore =
    findings.length > 0
      ? Number(
          (
            findings.reduce((sum, finding) => sum + finding.score, 0) /
            findings.length
          ).toFixed(2),
        )
      : 0.8;

  return {
    parts: updatedParts,
    report: {
      overallScore,
      findings,
    },
  };
}
