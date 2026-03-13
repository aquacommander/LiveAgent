import type {
  RequirementProfile,
  StoryPart,
  StoryPartKind,
  StorySafetyIssue,
  StorySafetyReport,
} from '../protocol.js';

const CATEGORY_PATTERNS: Array<{
  category: StorySafetyIssue['category'];
  severity: StorySafetyIssue['severity'];
  patterns: RegExp[];
}> = [
  {
    category: 'self_harm',
    severity: 'high',
    patterns: [/\bsuicide\b/i, /\bself-harm\b/i, /\bkill myself\b/i],
  },
  {
    category: 'hate',
    severity: 'high',
    patterns: [/\bethnic cleansing\b/i, /\bhate speech\b/i],
  },
  {
    category: 'sexual',
    severity: 'high',
    patterns: [/\bexplicit sexual\b/i, /\bnon-consensual\b/i],
  },
  {
    category: 'violence',
    severity: 'medium',
    patterns: [/\bgore\b/i, /\bdismember\b/i, /\btorture\b/i, /\bgraphic violence\b/i],
  },
  {
    category: 'illegal',
    severity: 'medium',
    patterns: [/\bbuild a bomb\b/i, /\bweaponize\b/i, /\bfraud guide\b/i],
  },
  {
    category: 'sensitive',
    severity: 'low',
    patterns: [/\bchild soldier\b/i, /\bextremist propaganda\b/i],
  },
];

function blockedKindsForSeverity(severity: StorySafetyIssue['severity']): StoryPartKind[] {
  if (severity === 'high') {
    return ['narration', 'voiceover', 'image_prompt', 'storyboard', 'hashtags'];
  }
  if (severity === 'medium') {
    return ['image_prompt', 'storyboard'];
  }
  return ['image_prompt'];
}

export function runStorySafetyChecks(
  requirementProfile: RequirementProfile,
  parts: StoryPart[],
): StorySafetyReport {
  const issues: StorySafetyIssue[] = [];

  for (const part of parts) {
    const content = `${part.content} ${requirementProfile.constraints.join(' ')}`;
    for (const rule of CATEGORY_PATTERNS) {
      if (rule.patterns.some((pattern) => pattern.test(content))) {
        issues.push({
          sceneId: part.sceneId,
          severity: rule.severity,
          category: rule.category,
          reason: `Matched ${rule.category} policy pattern in ${part.kind}.`,
          blockedKinds: blockedKindsForSeverity(rule.severity),
        });
      }
    }
  }

  const uniqueIssues = issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) =>
          candidate.sceneId === issue.sceneId &&
          candidate.category === issue.category &&
          candidate.severity === issue.severity,
      ) === index,
  );

  const hasHigh = uniqueIssues.some((issue) => issue.severity === 'high');
  const hasMedium = uniqueIssues.some((issue) => issue.severity === 'medium');
  return {
    status: hasHigh ? 'blocked' : hasMedium ? 'review' : 'safe',
    issues: uniqueIssues,
    reviewedAt: new Date().toISOString(),
  };
}

export function applySafetyGuardrails(
  parts: StoryPart[],
  report: StorySafetyReport,
): StoryPart[] {
  if (report.status === 'safe' || report.issues.length === 0) {
    return parts;
  }

  return parts.map((part) => {
    const sceneIssues = report.issues.filter((issue) => issue.sceneId === part.sceneId);
    if (sceneIssues.length === 0) {
      return part;
    }
    const shouldBlock = sceneIssues.some((issue) => issue.blockedKinds.includes(part.kind));
    if (!shouldBlock) {
      return part;
    }

    return {
      ...part,
      content:
        'This scene content was replaced due to safety policy review. Please provide a safer variation.',
      mediaType: 'text',
      mimeType: undefined,
      data: undefined,
      url: undefined,
    };
  });
}
