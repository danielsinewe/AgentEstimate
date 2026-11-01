import type {
  AmbiguityLevel,
  PromptAnalysis,
  ScopeLevel,
  TaskClass,
} from './types.js';

const ACTION_PATTERN =
  /\b(add|audit|build|change|check|clean|convert|create|debug|delete|deploy|design|diagnose|document|enhance|estimate|explain|fix|implement|improve|integrate|investigate|migrate|optimize|publish|refactor|release|remove|rename|repair|research|review|ship|test|update|verify|write)\b/gi;

const FILE_PATTERN =
  /(?:^|\s)(?:[\w@.-]+\/)+[\w@.-]+|\b[\w-]+\.(?:c|cc|cpp|css|go|html|java|js|json|jsx|kt|md|php|py|rb|rs|sql|swift|toml|ts|tsx|vue|yaml|yml)\b/gi;

const CLASS_RULES: ReadonlyArray<{
  taskClass: TaskClass;
  pattern: RegExp;
  weight: number;
}> = [
  {
    taskClass: 'migration',
    pattern: /\b(migrat(?:e|ion)|upgrade|port|move (?:from|to)|schema change)\b/i,
    weight: 5,
  },
  {
    taskClass: 'refactor',
    pattern: /\b(refactor|restructure|rewrite|architecture|modernize|technical debt)\b/i,
    weight: 5,
  },
  {
    taskClass: 'bugfix',
    pattern: /\b(fix|repair|resolve|patch|broken|regression|bug)\b/i,
    weight: 4,
  },
  {
    taskClass: 'diagnose',
    pattern: /\b(debug|diagnos|investigat|root cause|why (?:does|is|did)|failing|error)\b/i,
    weight: 4,
  },
  {
    taskClass: 'review',
    pattern: /\b(review|audit|assess|inspect|security scan|code quality)\b/i,
    weight: 4,
  },
  {
    taskClass: 'research',
    pattern: /\b(research|compare|benchmark|landscape|look up|find sources|market analysis)\b/i,
    weight: 4,
  },
  {
    taskClass: 'feature',
    pattern: /\b(build|create|implement|integrate|add|design|enhance|improve|make an? (?:app|tool|page|feature))\b/i,
    weight: 3,
  },
  {
    taskClass: 'question',
    pattern: /\b(explain|summarize|what is|how (?:do|does|can)|tell me|question)\b/i,
    weight: 2,
  },
];

const countMatches = (value: string, pattern: RegExp): number => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...value.matchAll(new RegExp(pattern.source, flags))].length;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const AMBIENT_CONTEXT_PATTERN = /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/giu;
const MY_REQUEST_PATTERN = /^##\s+My request:\s*$/gimu;
const RETROSPECTIVE_ETA_PATTERN = /\bOriginal ETA:\s*⏱/iu;

// A document's subject is not an instruction to perform that operation.
// Retain the document word so explicit fetch/browse requests still match below.
const DOCUMENT_SUBJECT = '(?:releases?|deployment|production|api|auth(?:entication)?|oauth|payments?|providers?|stripe|third[- ]party|integrations?|connectors?|webhooks?|vercel|cloudflare|app store)';
const DOCUMENT = '(?:docs?|documentation|notes?|guides?|checklists?|readme|changelog)';
const DOCUMENT_TOPIC_PATTERN = new RegExp(
  `\\b(?:${DOCUMENT_SUBJECT}[ -]+)+(${DOCUMENT})\\b|\\b(${DOCUMENT})\\s+(?:for|about|on)\\s+(?:(?:the|a|an|public|local)\\s+)*(?:${DOCUMENT_SUBJECT})(?:[ -]+${DOCUMENT_SUBJECT})*\\b`,
  'giu',
);

const NEGATION = "\\b(?:do not|don't|never|without|avoid|skip|no)\\s+(?:(?:actually|ever|any|the)\\s+)*";
const NEGATED_DEPLOY_PATTERN = new RegExp(`${NEGATION}(?:deploy(?:ing|ment)?|releas(?:e|ing)|publish(?:ing)?|ship(?:ping)?)\\b`, 'iu');
const NEGATED_EXTERNAL_PATTERN = new RegExp(`${NEGATION}(?:(?:external|network|remote)\\s+(?:requests?|calls?|access|apis?|services?|dependencies)|(?:call(?:ing)?|fetch(?:ing)?|brows(?:e|ing)|contact(?:ing)?|access(?:ing)?))\\b`, 'iu');

const DEPLOY_OPERATION_PATTERN = /\b(?:deploy(?:ment|ing)?|release|publish|ship|roll[ -]?out|go live)\b|\b(?:push|upload|promote|make)\b[^.;!?\n]{0,80}\b(?:production|live|vercel|cloudflare|app store)\b|\bvercel\s+(?:deploy\s+)?--prod\b/iu;

const requestedOperations = (prompt: string, negation: RegExp): string => prompt
  // A contrast or subsequent sentence can request real work after a prohibition.
  .split(/[;!?\n]|\.(?=\s|$)|\b(?:but|however|then|instead)\b/iu)
  .map((clause) => {
    const negated = negation.exec(clause);
    return negated ? clause.slice(0, negated.index) : clause;
  })
  .join(' ');

/**
 * Keeps host-provided UI state and pasted completion evidence from becoming
 * prospective work. The returned text stays in memory and is never persisted.
 */
const actionablePrompt = (prompt: string): string => {
  let focused = prompt.replace(AMBIENT_CONTEXT_PATTERN, ' ').trim();
  const requestMarkers = [...focused.matchAll(MY_REQUEST_PATTERN)];
  const lastRequest = requestMarkers.at(-1);
  if (lastRequest?.index !== undefined) {
    focused = focused.slice(lastRequest.index + lastRequest[0].length).trim();
  }

  // A common feedback shape is a short ETA question followed by a pasted
  // completion report. Treat the report as evidence, not a new deployment task.
  if (RETROSPECTIVE_ETA_PATTERN.test(focused)) {
    const leadingQuestion = focused.match(/^([\s\S]{1,280}?\?)(?:\s+Worked for\s+\d|\s*\n)/iu)?.[1];
    if (leadingQuestion && /\b(?:estimat(?:e|ed|es|ing|ion)?|eta|forecast|tim(?:e|ing))\b/iu.test(leadingQuestion)) {
      return leadingQuestion.trim();
    }
  }

  return focused;
};

const classifyTask = (prompt: string): TaskClass => {
  if (
    /^(?:please\s+)?(?:answer|output|print|reply|respond|return|say)\b/i.test(prompt.trim()) &&
    /\b(?:do not use tools|no tools|only)\b/i.test(prompt)
  ) {
    return 'question';
  }

  let best: { taskClass: TaskClass; score: number } = {
    taskClass: prompt.trim().endsWith('?') ? 'question' : 'feature',
    score: 0,
  };

  for (const rule of CLASS_RULES) {
    if (!rule.pattern.test(prompt)) continue;
    // Earlier and more specific rules win ties.
    if (rule.weight > best.score) best = { taskClass: rule.taskClass, score: rule.weight };
  }

  return best.taskClass;
};

const scopeFromScore = (score: number): ScopeLevel => {
  if (score <= 0) return 'micro';
  if (score === 1) return 'small';
  if (score === 2) return 'medium';
  if (score === 3) return 'large';
  return 'project';
};

const ambiguityFromScore = (score: number): AmbiguityLevel => {
  if (score < 0.34) return 'low';
  if (score < 0.67) return 'medium';
  return 'high';
};

/**
 * Extracts coarse workload signals without retaining or returning prompt text.
 * This function is pure and has no storage or network side effects.
 */
export const analyzePrompt = (prompt: string): PromptAnalysis => {
  const normalized = actionablePrompt(prompt);
  const operations = normalized.replace(DOCUMENT_TOPIC_PATTERN, (_match, before: string | undefined, after: string | undefined) => before ?? after ?? 'documentation');
  const externalOperations = requestedOperations(operations, NEGATED_EXTERNAL_PATTERN);
  const deployOperations = requestedOperations(operations, NEGATED_DEPLOY_PATTERN);
  const words = normalized.match(/[\p{L}\p{N}_'-]+/gu) ?? [];
  const wordCount = words.length;
  const actionCount = countMatches(operations, ACTION_PATTERN);
  const fileReferences = countMatches(normalized, FILE_PATTERN);
  const taskClass = classifyTask(normalized);

  let scopeScore = 0;
  if (wordCount >= 14) scopeScore += 1;
  if (wordCount >= 45) scopeScore += 1;
  if (wordCount >= 100) scopeScore += 1;
  if (actionCount >= 2) scopeScore += 1;
  if (actionCount >= 5) scopeScore += 1;
  if (fileReferences >= 3) scopeScore += 1;
  if (
    /\b(entire|end[- ]to[- ]end|full|complete|production[- ]ready|whole|across the|from scratch|perfect app|all pages|all files)\b/i.test(
      normalized,
    )
  ) {
    scopeScore += 2;
  }
  if (
    /\b(?:impress me|make (?:the |this )?(?:app|product|site|system|codebase) better|make it (?:more )?(?:accurate|reliable|trustworthy)|improve (?:the |this )?(?:app|product|site|system|codebase)(?:\s|$))\b/i.test(
      normalized,
    )
  ) {
    scopeScore += 3;
  }
  if (/\b(?:single|one|only|just)\s+(?:file|line|typo|function|component)\b/i.test(normalized)) {
    scopeScore -= 2;
  }
  if (/\b(?:typo|one[- ]line|copy change|text change)\b/i.test(normalized)) {
    scopeScore -= 2;
  }
  scopeScore = clamp(scopeScore, 0, 5);

  let ambiguityScore = normalized.length === 0 ? 0.9 : 0.34;
  if (
    /\b(whatever|somehow|i don'?t know|figure it out|impress me|make (?:it|.+) better|make it (?:more )?(?:accurate|reliable|trustworthy)|improve it|perfect|best possible|as needed|etc\.?|something|doesn'?t work)\b/i.test(
      normalized,
    )
  ) {
    ambiguityScore += 0.28;
  }
  if (taskClass !== 'question' && fileReferences === 0) ambiguityScore += 0.12;
  if (actionCount >= 4) ambiguityScore += 0.08;
  if (/\b(must|should|acceptance|when |given |exactly|do not|only)\b/i.test(normalized)) {
    ambiguityScore -= 0.16;
  }
  if (fileReferences > 0) ambiguityScore -= 0.12;
  if (/```|\btests? (?:must|should|expect)|\bexpected (?:result|output|behavior)\b/i.test(normalized)) {
    ambiguityScore -= 0.12;
  }
  if (
    /^(?:please\s+)?(?:answer|output|print|reply|respond|return|say)\b/i.test(normalized) &&
    /\b(?:do not use tools|no tools|only)\b/i.test(normalized)
  ) {
    ambiguityScore = Math.min(ambiguityScore, 0.12);
  }
  ambiguityScore = clamp(ambiguityScore, 0.08, 0.95);

  const signals = {
    external:
      taskClass === 'research' ||
      /\b(api|auth(?:entication)?|external|google sign[- ]in|oauth|payment|provider|sign[- ]in provider|stripe|third[- ]party|internet|web search|integration|connector|scrape|webhook)\b/i.test(externalOperations) ||
      /https?:\/\//iu.test(externalOperations) ||
      /\b(?:fetch|browse|download|retrieve)\b[^.;!?\n]{0,80}\b(?:docs?|documentation)\b|\b(?:online|remote|official)\s+(?:docs?|documentation)\b|\b(?:docs?|documentation)\s+(?:online|remotely)\b/iu.test(externalOperations),
    tests:
      /\b(test(?:s|ed|ing)?|vitest|jest|pytest|specs?|coverage|qa|regression suite|typecheck|lint)\b/i.test(
        normalized,
      ),
    browser:
      /\b(browser|playwright|website|webpage|web app|ui|ux|screenshot|chrome|safari|live site|visual)\b/i.test(
        normalized,
      ),
    deploy:
      // A provider name or a word inside a documentation URL is not a release.
      DEPLOY_OPERATION_PATTERN.test(deployOperations.replace(/https?:\/\/\S+/giu, ' ')),
    destructive:
      /\b(delete|drop|truncate|purge|remove all|overwrite|reset|uninstall)\b/i.test(normalized),
  };

  const scope = scopeFromScore(scopeScore);
  const ambiguity = ambiguityFromScore(ambiguityScore);
  const drivers: string[] = [`${taskClass} task`, `${scope} scope`, `${ambiguity} ambiguity`];
  if (signals.external) drivers.push('external dependency');
  if (signals.tests) drivers.push('test verification');
  if (signals.browser) drivers.push('browser verification');
  if (signals.deploy) drivers.push('deployment');
  if (signals.destructive) drivers.push('destructive-operation safeguards');

  return {
    taskClass,
    scope,
    scopeScore,
    ambiguity,
    ambiguityScore: Math.round(ambiguityScore * 100) / 100,
    signals,
    wordCount,
    actionCount,
    drivers,
  };
};
