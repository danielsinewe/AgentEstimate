#!/usr/bin/env node

// src/hook.ts
import { createHash as createHash2 } from "crypto";
import { pathToFileURL } from "url";

// ../core/dist/prompt.js
var ACTION_PATTERN = /\b(add|audit|build|change|check|clean|convert|create|debug|delete|deploy|design|diagnose|document|estimate|explain|fix|implement|integrate|investigate|migrate|optimize|publish|refactor|release|remove|repair|research|review|ship|test|update|verify|write)\b/gi;
var FILE_PATTERN = /(?:^|\s)(?:[\w@.-]+\/)+[\w@.-]+|\b[\w-]+\.(?:c|cc|cpp|css|go|html|java|js|json|jsx|kt|md|php|py|rb|rs|sql|swift|toml|ts|tsx|vue|yaml|yml)\b/gi;
var CLASS_RULES = [
  {
    taskClass: "migration",
    pattern: /\b(migrat(?:e|ion)|upgrade|port|move (?:from|to)|schema change)\b/i,
    weight: 5
  },
  {
    taskClass: "refactor",
    pattern: /\b(refactor|restructure|rewrite|architecture|modernize|technical debt)\b/i,
    weight: 5
  },
  {
    taskClass: "bugfix",
    pattern: /\b(fix|repair|resolve|patch|broken|regression|bug)\b/i,
    weight: 4
  },
  {
    taskClass: "diagnose",
    pattern: /\b(debug|diagnos|investigat|root cause|why (?:does|is|did)|failing|error)\b/i,
    weight: 4
  },
  {
    taskClass: "review",
    pattern: /\b(review|audit|assess|inspect|security scan|code quality)\b/i,
    weight: 4
  },
  {
    taskClass: "research",
    pattern: /\b(research|compare|benchmark|landscape|look up|find sources|market analysis)\b/i,
    weight: 4
  },
  {
    taskClass: "feature",
    pattern: /\b(build|create|implement|integrate|add|design|make an? (?:app|tool|page|feature))\b/i,
    weight: 3
  },
  {
    taskClass: "question",
    pattern: /\b(explain|summarize|what is|how (?:do|does|can)|tell me|question)\b/i,
    weight: 2
  }
];
var countMatches = (value, pattern) => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...value.matchAll(new RegExp(pattern.source, flags))].length;
};
var clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
var classifyTask = (prompt) => {
  let best = {
    taskClass: prompt.trim().endsWith("?") ? "question" : "feature",
    score: 0
  };
  for (const rule of CLASS_RULES) {
    if (!rule.pattern.test(prompt))
      continue;
    if (rule.weight > best.score)
      best = { taskClass: rule.taskClass, score: rule.weight };
  }
  return best.taskClass;
};
var scopeFromScore = (score) => {
  if (score <= 0)
    return "micro";
  if (score === 1)
    return "small";
  if (score === 2)
    return "medium";
  if (score === 3)
    return "large";
  return "project";
};
var ambiguityFromScore = (score) => {
  if (score < 0.34)
    return "low";
  if (score < 0.67)
    return "medium";
  return "high";
};
var analyzePrompt = (prompt) => {
  const normalized = prompt.trim();
  const words = normalized.match(/[\p{L}\p{N}_'-]+/gu) ?? [];
  const wordCount = words.length;
  const actionCount = countMatches(normalized, ACTION_PATTERN);
  const fileReferences = countMatches(normalized, FILE_PATTERN);
  const taskClass = classifyTask(normalized);
  let scopeScore = 0;
  if (wordCount >= 14)
    scopeScore += 1;
  if (wordCount >= 45)
    scopeScore += 1;
  if (wordCount >= 100)
    scopeScore += 1;
  if (actionCount >= 2)
    scopeScore += 1;
  if (actionCount >= 5)
    scopeScore += 1;
  if (fileReferences >= 3)
    scopeScore += 1;
  if (/\b(entire|end[- ]to[- ]end|full|complete|production[- ]ready|whole|across the|from scratch|perfect app|all pages|all files)\b/i.test(normalized)) {
    scopeScore += 2;
  }
  if (/\b(single|one|only|just)\s+(?:file|line|typo|function|component)\b/i.test(normalized)) {
    scopeScore -= 1;
  }
  scopeScore = clamp(scopeScore, 0, 5);
  let ambiguityScore = normalized.length === 0 ? 0.9 : 0.34;
  if (/\b(whatever|somehow|i don'?t know|make it better|improve it|perfect|best possible|as needed|etc\.?|something|doesn'?t work)\b/i.test(normalized)) {
    ambiguityScore += 0.28;
  }
  if (taskClass !== "question" && fileReferences === 0)
    ambiguityScore += 0.12;
  if (actionCount >= 4)
    ambiguityScore += 0.08;
  if (/\b(must|should|acceptance|when |given |exactly|do not|only)\b/i.test(normalized)) {
    ambiguityScore -= 0.16;
  }
  if (fileReferences > 0)
    ambiguityScore -= 0.12;
  if (/```|\btests? (?:must|should|expect)|\bexpected (?:result|output|behavior)\b/i.test(normalized)) {
    ambiguityScore -= 0.12;
  }
  ambiguityScore = clamp(ambiguityScore, 0.08, 0.95);
  const signals = {
    external: taskClass === "research" || /\b(api|external|third[- ]party|internet|web search|documentation|docs|oauth|integration|connector|scrape|provider)\b/i.test(normalized),
    tests: /\b(test(?:s|ed|ing)?|vitest|jest|pytest|specs?|coverage|qa|regression suite|typecheck|lint)\b/i.test(normalized),
    browser: /\b(browser|playwright|website|webpage|web app|ui|ux|screenshot|chrome|safari|live site|visual)\b/i.test(normalized),
    deploy: /\b(deploy|deployment|production|release|publish|ship|vercel|cloudflare|app store)\b/i.test(normalized),
    destructive: /\b(delete|drop|truncate|purge|remove all|overwrite|reset|uninstall)\b/i.test(normalized)
  };
  const scope = scopeFromScore(scopeScore);
  const ambiguity = ambiguityFromScore(ambiguityScore);
  const drivers = [`${taskClass} task`, `${scope} scope`, `${ambiguity} ambiguity`];
  if (signals.external)
    drivers.push("external dependency");
  if (signals.tests)
    drivers.push("test verification");
  if (signals.browser)
    drivers.push("browser verification");
  if (signals.deploy)
    drivers.push("deployment");
  if (signals.destructive)
    drivers.push("destructive-operation safeguards");
  return {
    taskClass,
    scope,
    scopeScore,
    ambiguity,
    ambiguityScore: Math.round(ambiguityScore * 100) / 100,
    signals,
    wordCount,
    actionCount,
    drivers
  };
};

// ../core/dist/calibration.js
var CALIBRATION_BOUNDS = [0.6, 1.75];
var RATIO_BOUNDS = [0.25, 4];
var clamp2 = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
var median = (values) => {
  if (values.length === 0)
    return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1)
    return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
var robustLogCenter = (samples) => {
  const values = samples.map((sample) => Math.log(clamp2(sample.actualMinutes / sample.estimatedMinutes, ...RATIO_BOUNDS)));
  if (values.length === 0)
    return 0;
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const limit = Math.max(0.18, 2.5 * 1.4826 * mad);
  const winsorized = values.map((value) => clamp2(value, center - limit, center + limit));
  return winsorized.reduce((sum, value) => sum + value, 0) / winsorized.length;
};
var robustDispersionMultiplier = (samples) => {
  if (samples.length < 8)
    return 1;
  const values = samples.map((sample) => Math.log(clamp2(sample.actualMinutes / sample.estimatedMinutes, ...RATIO_BOUNDS)));
  const center = median(values);
  const robustScale = Math.max(0.08, 1.4826 * median(values.map((value) => Math.abs(value - center))));
  const rawMultiplier = clamp2(robustScale / 0.34, 0.65, 1.8);
  const evidenceWeight = samples.length / (samples.length + 12);
  return 1 + (rawMultiplier - 1) * evidenceWeight;
};
var shrinkToward = (prior, samples, priorStrength) => {
  if (samples.length === 0)
    return prior;
  const weight = samples.length / (samples.length + priorStrength);
  return prior * (1 - weight) + robustLogCenter(samples) * weight;
};
var isEstimateInput = (value) => "prompt" in value && typeof value.prompt === "string";
var normalizeContext = (context) => {
  if (typeof context === "string")
    return { taskClass: context };
  if (!isEstimateInput(context))
    return context;
  return {
    taskClass: context.taskClass ?? analyzePrompt(context.prompt).taskClass,
    provider: context.provider,
    model: context.model,
    effort: context.effort,
    speed: context.speed
  };
};
var usableSamples = (samples) => samples.filter((sample) => Number.isFinite(sample.estimatedMinutes) && Number.isFinite(sample.actualMinutes) && sample.estimatedMinutes > 0 && sample.actualMinutes > 0);
var calibrate = (samples, context) => {
  const usable = usableSamples(samples);
  if (usable.length === 0) {
    return {
      multiplier: 1,
      dispersionMultiplier: 1,
      sampleCount: 0,
      matchedSampleCount: 0,
      level: "none",
      applied: false,
      bounds: CALIBRATION_BOUNDS
    };
  }
  const target = normalizeContext(context);
  let logMultiplier = shrinkToward(0, usable, 12);
  let matchedSampleCount = usable.length;
  let dispersionSamples = usable;
  let level = "global";
  const applyLevel = (cohort, nextLevel, priorStrength, minimumSamples) => {
    if (cohort.length < minimumSamples)
      return;
    logMultiplier = shrinkToward(logMultiplier, cohort, priorStrength);
    matchedSampleCount = cohort.length;
    level = nextLevel;
    if (cohort.length >= 8)
      dispersionSamples = cohort;
  };
  const providerSamples = target.provider ? usable.filter((sample) => sample.provider === target.provider) : [];
  applyLevel(providerSamples, "provider", 7, 2);
  const taskSamples = target.taskClass ? usable.filter((sample) => sample.taskClass === target.taskClass) : [];
  applyLevel(taskSamples, "task", 6, 2);
  const providerTaskSamples = target.provider && target.taskClass ? usable.filter((sample) => sample.provider === target.provider && sample.taskClass === target.taskClass) : [];
  applyLevel(providerTaskSamples, "provider-task", 4, 3);
  const normalizedModel = target.model?.trim().toLowerCase();
  const exactSamples = usable.filter((sample) => {
    if (target.taskClass && sample.taskClass !== target.taskClass)
      return false;
    if (target.provider && sample.provider !== target.provider)
      return false;
    if (normalizedModel && sample.model?.trim().toLowerCase() !== normalizedModel)
      return false;
    if (target.effort && sample.effort !== target.effort)
      return false;
    if (target.speed && sample.speed !== target.speed)
      return false;
    return Boolean(normalizedModel || target.effort || target.speed);
  });
  applyLevel(exactSamples, "model-effort", 3, 4);
  const multiplier = clamp2(Math.exp(logMultiplier), ...CALIBRATION_BOUNDS);
  const dispersionMultiplier = robustDispersionMultiplier(dispersionSamples);
  return {
    multiplier: Math.round(multiplier * 1e3) / 1e3,
    dispersionMultiplier: Math.round(dispersionMultiplier * 1e3) / 1e3,
    sampleCount: usable.length,
    matchedSampleCount,
    level,
    applied: Math.abs(multiplier - 1) >= 5e-3 || Math.abs(dispersionMultiplier - 1) >= 0.025,
    bounds: CALIBRATION_BOUNDS
  };
};

// ../core/dist/estimate.js
var STAGES = [
  { stage: "orient", label: "Orient", modelBound: true },
  { stage: "reason", label: "Reason", modelBound: true },
  { stage: "change", label: "Change", modelBound: true },
  { stage: "verify", label: "Verify", modelBound: false },
  { stage: "deliver", label: "Deliver", modelBound: false }
];
var BASE_MINUTES = {
  question: { orient: 1.5, reason: 5, change: 0.5, verify: 1, deliver: 1 },
  research: { orient: 3, reason: 14, change: 1, verify: 3, deliver: 2 },
  review: { orient: 4, reason: 10, change: 1, verify: 6, deliver: 2 },
  diagnose: { orient: 5, reason: 13, change: 3, verify: 5, deliver: 2 },
  bugfix: { orient: 5, reason: 10, change: 12, verify: 8, deliver: 2 },
  feature: { orient: 6, reason: 10, change: 22, verify: 10, deliver: 3 },
  refactor: { orient: 7, reason: 12, change: 26, verify: 14, deliver: 3 },
  migration: { orient: 9, reason: 16, change: 35, verify: 18, deliver: 5 }
};
var SCOPE_FACTORS = {
  micro: 0.5,
  small: 0.76,
  medium: 1,
  large: 1.55,
  project: 2.35
};
var SCOPE_STAGE_WEIGHTS = {
  orient: 0.65,
  reason: 0.75,
  change: 1,
  verify: 0.8,
  deliver: 0.35
};
var AMBIGUITY_FACTORS = {
  low: 0.9,
  medium: 1,
  high: 1.28
};
var AMBIGUITY_STAGE_WEIGHTS = {
  orient: 0.4,
  reason: 1,
  change: 0.55,
  verify: 0.35,
  deliver: 0.15
};
var EFFORT_FACTORS = {
  low: { orient: 0.9, reason: 0.62, change: 0.88, verify: 0.82, deliver: 0.92 },
  medium: { orient: 1, reason: 1, change: 1, verify: 1, deliver: 1 },
  high: { orient: 1.06, reason: 1.34, change: 1.1, verify: 1.12, deliver: 1.02 },
  xhigh: { orient: 1.12, reason: 1.7, change: 1.16, verify: 1.2, deliver: 1.04 },
  max: { orient: 1.18, reason: 2.1, change: 1.22, verify: 1.28, deliver: 1.06 }
};
var EFFORT_INDEX = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4
};
var REPO_STAGE_WEIGHTS = {
  orient: 1,
  reason: 0.45,
  change: 0.25,
  verify: 0.35,
  deliver: 0.08
};
var SIGNAL_ADDITIONS = {
  external: { orient: 1.5, reason: 3, change: 4, verify: 5, deliver: 1 },
  tests: { orient: 0.5, reason: 0.5, change: 2, verify: 6, deliver: 0.5 },
  browser: { orient: 1, reason: 0.5, change: 3, verify: 5, deliver: 0.5 },
  deploy: { orient: 0.5, reason: 0.5, change: 1.5, verify: 5, deliver: 8 },
  destructive: { orient: 1, reason: 2, change: 1, verify: 4, deliver: 1 }
};
var DEFAULT_SEED = 1095062593;
var SIMULATION_COUNT = 1600;
var clamp3 = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
var roundMinute = (value) => Math.round(value * 10) / 10;
var lerpFromOne = (factor, weight) => 1 + (factor - 1) * weight;
var safeMetric = (value) => Number.isFinite(value) && (value ?? 0) > 0 ? value ?? 0 : 0;
var repoPrior = (repo) => {
  if (!repo)
    return 1;
  const files = safeMetric(repo.fileCount);
  const lines = safeMetric(repo.linesOfCode);
  const tests = safeMetric(repo.testFileCount);
  const languages = safeMetric(repo.languageCount);
  const dependencies = safeMetric(repo.dependencyCount);
  const packages = safeMetric(repo.packageCount);
  const increment = 0.034 * Math.log1p(files / 40) + 0.017 * Math.log1p(lines / 5e3) + 8e-3 * Math.log1p(tests / 20) + 0.01 * Math.log1p(languages) + 9e-3 * Math.log1p(dependencies / 20) + 0.014 * Math.log1p(packages);
  return 1 + clamp3(increment, 0, 0.24);
};
var modelProfile = (provider, model) => {
  const name = model.trim().toLowerCase();
  if (/haiku|mini|spark|flash|nano|luna/.test(name)) {
    return { pace: 0.74, capability: 0.86, label: "fast model tier" };
  }
  if (/fable|opus|ultra|gpt-5\.6-sol/.test(name)) {
    return { pace: 1.16, capability: 1.08, label: "deep model tier" };
  }
  if (/sonnet|terra/.test(name)) {
    return { pace: 0.93, capability: 1.01, label: "balanced model tier" };
  }
  if (/gpt-5\.6|gpt-5\.5|codex/.test(name)) {
    return { pace: 0.9, capability: 1.03, label: "agentic model tier" };
  }
  if (/gpt-5|claude/.test(name)) {
    return { pace: 0.97, capability: 1, label: "general model tier" };
  }
  return {
    pace: provider === "codex" ? 0.96 : 1,
    capability: 1,
    label: "unknown model neutral prior"
  };
};
var hashSeed = (seed) => {
  if (typeof seed === "number" && Number.isFinite(seed))
    return seed >>> 0;
  if (typeof seed !== "string")
    return DEFAULT_SEED;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
var createRandom = (initialSeed) => {
  let state = initialSeed || 1831565813;
  return () => {
    state += 1831565813;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
};
var normal = (random) => {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};
var percentile = (sorted, probability) => {
  if (sorted.length === 0)
    return 0;
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
};
var summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const expected = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    p25: roundMinute(percentile(sorted, 0.25)),
    p50: roundMinute(percentile(sorted, 0.5)),
    p80: roundMinute(percentile(sorted, 0.8)),
    p95: roundMinute(percentile(sorted, 0.95)),
    expected: roundMinute(expected)
  };
};
var resolveAnalysis = (input) => {
  const inferred = analyzePrompt(input.prompt);
  const options = input.options;
  const signals = {
    external: options?.external ?? inferred.signals.external,
    tests: options?.tests ?? inferred.signals.tests,
    browser: options?.browser ?? inferred.signals.browser,
    deploy: options?.deploy ?? inferred.signals.deploy,
    destructive: options?.destructive ?? inferred.signals.destructive
  };
  const taskClass = input.taskClass ?? inferred.taskClass;
  const scope = options?.scope ?? inferred.scope;
  const ambiguity = options?.ambiguity ?? inferred.ambiguity;
  const scopeScore = {
    micro: 0,
    small: 1,
    medium: 2,
    large: 3,
    project: 4
  };
  const ambiguityScore = {
    low: 0.2,
    medium: 0.5,
    high: 0.82
  };
  const drivers = [`${taskClass} task`, `${scope} scope`, `${ambiguity} ambiguity`];
  if (signals.external)
    drivers.push("external dependency");
  if (signals.tests)
    drivers.push("test verification");
  if (signals.browser)
    drivers.push("browser verification");
  if (signals.deploy)
    drivers.push("deployment");
  if (signals.destructive)
    drivers.push("destructive-operation safeguards");
  return {
    ...inferred,
    taskClass,
    scope,
    scopeScore: options?.scope ? scopeScore[scope] : inferred.scopeScore,
    ambiguity,
    ambiguityScore: options?.ambiguity ? ambiguityScore[ambiguity] : inferred.ambiguityScore,
    signals,
    drivers
  };
};
var stageCenters = (input, analysis, calibrationMultiplier) => {
  const model = modelProfile(input.provider, input.model);
  const prior = repoPrior(input.repo);
  const scopeFactor = SCOPE_FACTORS[analysis.scope];
  const ambiguityFactor = AMBIGUITY_FACTORS[analysis.ambiguity];
  const expectedFiles = safeMetric(input.options?.expectedFiles);
  const fileFactor = expectedFiles > 0 ? 1 + clamp3(0.08 * Math.log1p(expectedFiles), 0, 0.34) : 1;
  const complexity = clamp3((SCOPE_FACTORS[analysis.scope] - 0.5) / 1.85 + analysis.ambiguityScore * 0.25, 0, 1.25);
  const capabilityFactor = 1 + Math.max(0, 1 - model.capability) * complexity * 0.55;
  const providerFactors = {
    codex: { orient: 0.96, reason: 1, change: 0.95, verify: 0.98, deliver: 1 },
    claude: { orient: 1, reason: 0.97, change: 1, verify: 1, deliver: 0.98 }
  };
  const centers = {};
  const drivers = {};
  for (const definition of STAGES) {
    const stage = definition.stage;
    let minutes = BASE_MINUTES[analysis.taskClass][stage];
    const stageDrivers = [`${analysis.taskClass} baseline`];
    minutes *= lerpFromOne(scopeFactor, SCOPE_STAGE_WEIGHTS[stage]);
    stageDrivers.push(`${analysis.scope} scope`);
    minutes *= lerpFromOne(ambiguityFactor, AMBIGUITY_STAGE_WEIGHTS[stage]);
    if (analysis.ambiguity !== "medium")
      stageDrivers.push(`${analysis.ambiguity} ambiguity`);
    minutes *= EFFORT_FACTORS[input.effort][stage];
    if (input.effort !== "medium")
      stageDrivers.push(`${input.effort} reasoning effort`);
    minutes *= lerpFromOne(prior, REPO_STAGE_WEIGHTS[stage]);
    if (prior > 1.01 && REPO_STAGE_WEIGHTS[stage] >= 0.25)
      stageDrivers.push("repository prior");
    minutes *= lerpFromOne(fileFactor, stage === "change" ? 1 : 0.35);
    minutes *= providerFactors[input.provider][stage];
    if (definition.modelBound) {
      minutes *= model.pace * capabilityFactor;
      stageDrivers.push(model.label);
      if (input.speed === "fast") {
        const fastFactor = clamp3(0.64 + (1 - model.pace) * 0.2 + EFFORT_INDEX[input.effort] * 0.035, 0.66, 0.82);
        minutes *= fastFactor;
        stageDrivers.push("fast mode");
      }
    }
    for (const signal of ["external", "tests", "browser", "deploy", "destructive"]) {
      if (!analysis.signals[signal])
        continue;
      minutes += SIGNAL_ADDITIONS[signal][stage];
      if (SIGNAL_ADDITIONS[signal][stage] >= 1)
        stageDrivers.push(signal);
    }
    minutes *= calibrationMultiplier;
    if (Math.abs(calibrationMultiplier - 1) >= 5e-3)
      stageDrivers.push("personal calibration");
    centers[stage] = Math.max(0.2, minutes);
    drivers[stage] = stageDrivers;
  }
  return { centers, drivers, model };
};
var simulationSigma = (analysis, dispersionMultiplier) => {
  const base = { low: 0.22, medium: 0.34, high: 0.5 };
  let sigma = base[analysis.ambiguity];
  if (analysis.signals.external)
    sigma += 0.06;
  if (analysis.taskClass === "research" || analysis.taskClass === "diagnose")
    sigma += 0.035;
  return sigma * dispersionMultiplier;
};
var confidenceFor = (analysis, minutes, calibrationSamples) => {
  const spread = Math.round(minutes.p95 / Math.max(0.1, minutes.p50) * 100) / 100;
  if (analysis.ambiguity === "low" && !analysis.signals.external && (!analysis.signals.deploy || calibrationSamples >= 8)) {
    return {
      level: "high",
      spread,
      reason: calibrationSamples >= 8 ? "Clear scope with personal history" : "Clear, local scope"
    };
  }
  if (analysis.ambiguity === "high" || analysis.signals.external && analysis.signals.deploy) {
    return {
      level: "low",
      spread,
      reason: analysis.ambiguity === "high" ? "Requirements remain ambiguous" : "External release path"
    };
  }
  return {
    level: "medium",
    spread,
    reason: calibrationSamples > 0 ? "Some personal history available" : "Heuristic baseline"
  };
};
var formatDuration = (minutes) => {
  if (!Number.isFinite(minutes) || minutes < 0)
    return "\u2014";
  if (minutes < 1)
    return "<1 min";
  const rounded = Math.round(minutes);
  if (rounded < 60)
    return `${rounded} min`;
  if (rounded < 1440) {
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
  }
  const days = Math.floor(rounded / 1440);
  const remainingHours = Math.round(rounded % 1440 / 60);
  if (remainingHours === 24)
    return `${days + 1} day${days + 1 === 1 ? "" : "s"}`;
  return remainingHours === 0 ? `${days} day${days === 1 ? "" : "s"}` : `${days}d ${remainingHours} hr`;
};
var estimateTask = (input) => {
  const analysis = resolveAnalysis(input);
  const calibration = calibrate(input.calibrationSamples ?? [], input);
  const { centers, drivers: stageDrivers } = stageCenters(input, analysis, calibration.multiplier);
  const resolvedSeed = hashSeed(input.seed);
  const random = createRandom(resolvedSeed);
  const sigma = simulationSigma(analysis, calibration.dispersionMultiplier);
  const valuesByStage = {
    orient: [],
    reason: [],
    change: [],
    verify: [],
    deliver: []
  };
  const totals = [];
  for (let simulation = 0; simulation < SIMULATION_COUNT; simulation += 1) {
    const sharedShock = normal(random);
    let total = 0;
    for (const definition of STAGES) {
      const stageShock = normal(random);
      const stageSigma = sigma * (definition.stage === "reason" ? 1.08 : definition.stage === "deliver" ? 0.82 : 1);
      const combinedShock = sharedShock * 0.48 + stageShock * 0.877;
      const sampled = centers[definition.stage] * Math.exp(combinedShock * stageSigma);
      valuesByStage[definition.stage].push(sampled);
      total += sampled;
    }
    totals.push(total);
  }
  const minutes = summarize(totals);
  const stages = STAGES.map((definition) => {
    const stageMinutes = summarize(valuesByStage[definition.stage]);
    return {
      ...definition,
      minutes: stageMinutes,
      shareOfP50: Math.round(stageMinutes.p50 / Math.max(0.1, minutes.p50) * 1e3) / 1e3,
      drivers: stageDrivers[definition.stage]
    };
  });
  const prior = repoPrior(input.repo);
  const drivers = [...analysis.drivers];
  if (prior > 1.01)
    drivers.push(`repository prior +${Math.round((prior - 1) * 100)}% at orientation`);
  if (input.speed === "fast")
    drivers.push("fast mode on model-bound stages only");
  if (Math.abs(calibration.multiplier - 1) >= 5e-3) {
    drivers.push(`personal center calibration \xD7${calibration.multiplier}`);
  }
  if (Math.abs(calibration.dispersionMultiplier - 1) >= 0.025) {
    drivers.push(`personal interval width \xD7${calibration.dispersionMultiplier}`);
  }
  const assumptions = [];
  if (!input.repo || Object.values(input.repo).every((value) => !safeMetric(value))) {
    assumptions.push("Repository size not supplied; neutral repository prior used.");
  }
  if (!analysis.signals.tests)
    assumptions.push("No explicit test run included.");
  if (!analysis.signals.deploy)
    assumptions.push("No production deployment included.");
  if (!calibration.applied)
    assumptions.push("No material personal calibration available.");
  return {
    minutes,
    formatted: {
      p25: formatDuration(minutes.p25),
      p50: formatDuration(minutes.p50),
      p80: formatDuration(minutes.p80),
      p95: formatDuration(minutes.p95),
      expected: formatDuration(minutes.expected)
    },
    stages,
    analysis,
    confidence: confidenceFor(analysis, minutes, calibration.sampleCount),
    drivers,
    assumptions,
    calibration,
    seed: resolvedSeed
  };
};

// src/privacy.ts
function derivePromptFeatures(prompt) {
  const bounded = prompt.slice(0, 1e5);
  const trimmed = bounded.trim();
  const words = trimmed ? trimmed.split(/\s+/u).length : 0;
  const lines = trimmed ? trimmed.split(/\r?\n/u).length : 0;
  const checklistItems = (bounded.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/gu) ?? []).length;
  const analysis = analyzePrompt(bounded);
  return {
    characters: bounded.length,
    words,
    lines,
    checklistItems,
    taskClass: analysis.taskClass,
    scope: analysis.scope,
    ambiguity: analysis.ambiguity,
    external: analysis.signals.external,
    tests: analysis.signals.tests,
    browser: analysis.signals.browser,
    deploy: analysis.signals.deploy,
    destructive: analysis.signals.destructive
  };
}
function normalizeProvider(value, fallback = "codex") {
  return typeof value === "string" && value.toLowerCase().includes("claude") ? "claude" : fallback;
}
function normalizeEffort(value) {
  if (typeof value !== "string") return "medium";
  const normalized = value.toLowerCase().replace(/[-_ ]/gu, "");
  if (normalized === "low" || normalized === "minimal" || normalized === "none") return "low";
  if (normalized === "high") return "high";
  if (normalized === "xhigh" || normalized === "veryhigh") return "xhigh";
  if (normalized === "max" || normalized === "ultra") return "max";
  return "medium";
}
function normalizeSpeed(value) {
  return typeof value === "string" && /(?:fast|priority|express)/iu.test(value) ? "fast" : "standard";
}
function normalizeModel(value, provider) {
  if (typeof value !== "string" || !value.trim()) return provider === "codex" ? "codex-default" : "claude-default";
  return value.trim().replace(/[^a-zA-Z0-9._:/-]/gu, "-").slice(0, 80) || `${provider}-default`;
}
function toStoredEstimate(estimate) {
  return {
    minutes: {
      p25: estimate.minutes.p25,
      p50: estimate.minutes.p50,
      p80: estimate.minutes.p80,
      p95: estimate.minutes.p95,
      expected: estimate.minutes.expected
    },
    formatted: {
      p50: estimate.formatted.p50,
      p80: estimate.formatted.p80
    },
    confidence: estimate.confidence
  };
}
function toStoredFeatures(input) {
  return {
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    speed: input.speed,
    prompt: input.prompt,
    repo: {
      fileCount: input.repo.fileCount,
      linesOfCode: input.repo.linesOfCode,
      testFileCount: input.repo.testFileCount,
      languageCount: input.repo.languageCount,
      dependencyCount: input.repo.dependencyCount,
      packageCount: input.repo.packageCount,
      dirtyFileCount: input.repo.dirtyFileCount
    }
  };
}

// src/repo-profile.ts
import { execFile } from "child_process";
import { constants } from "fs";
import { lstat, open, opendir } from "fs/promises";
import { extname, join, relative, resolve, sep } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var EXCLUDED_DIRECTORIES = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  ".venv",
  ".yarn",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "deriveddata",
  "dist",
  "node_modules",
  "out",
  "pods",
  "target",
  "vendor",
  "venv"
]);
var BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dmg",
  ".doc",
  ".docx",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".tar",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip"
]);
var LANGUAGE_BY_EXTENSION = {
  ".astro": "astro",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".lua": "lua",
  ".md": "markdown",
  ".mjs": "javascript",
  ".php": "php",
  ".pl": "perl",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".sh": "shell",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".tsx": "typescript",
  ".ts": "typescript",
  ".vue": "vue"
};
var TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$/iu;
function normalizeRelativePath(path) {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}
function isExcludedRepositoryPath(path) {
  const normalized = normalizeRelativePath(path);
  const segments = normalized.toLowerCase().split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return true;
  return BINARY_EXTENSIONS.has(extname(normalized).toLowerCase());
}
async function gitRoot(cwd, timeout) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    });
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}
async function gitFiles(root, timeout) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer"
    });
    return stdout.toString("utf8").split("\0").filter(Boolean).map(normalizeRelativePath).filter((path) => !isExcludedRepositoryPath(path));
  } catch {
    return null;
  }
}
async function filesystemFiles(root, maxFiles, deadline) {
  const files = [];
  const directories = [root];
  while (directories.length > 0 && files.length < maxFiles && Date.now() < deadline) {
    const directory = directories.pop();
    if (!directory) break;
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const path = normalizeRelativePath(relative(root, absolute));
      if (isExcludedRepositoryPath(path)) continue;
      if (entry.isDirectory()) directories.push(absolute);
      else if (entry.isFile()) files.push(path);
      if (files.length >= maxFiles) break;
    }
  }
  return { files, truncated: directories.length > 0 || files.length >= maxFiles };
}
async function readBoundedFile(path, maxBytes) {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const file = await handle.stat();
      if (!file.isFile()) return null;
      const byteCount = Math.min(file.size, maxBytes);
      const bytes = Buffer.alloc(byteCount);
      const { bytesRead } = byteCount > 0 ? await handle.read(bytes, 0, byteCount, 0) : { bytesRead: 0 };
      return { bytes: bytes.subarray(0, bytesRead), fileSize: file.size };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
async function countLines(path, maxBytes) {
  const file = await readBoundedFile(path, maxBytes);
  if (!file) return null;
  if (file.bytes.includes(0)) return 0;
  if (file.bytes.length === 0) return 0;
  let sampledLines = 1;
  for (const byte of file.bytes) if (byte === 10) sampledLines += 1;
  return Math.max(1, Math.round(sampledLines * (file.fileSize / file.bytes.length)));
}
async function mapWithConcurrency(values, concurrency, deadline, operation) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (Date.now() < deadline) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === void 0) return;
      results.push(await operation(value));
    }
  });
  await Promise.all(workers);
  return results;
}
async function sumDependencies(root, packageFiles, deadline) {
  let count = 0;
  for (const path of packageFiles.slice(0, 100)) {
    if (Date.now() >= deadline) break;
    try {
      const file = await readBoundedFile(join(root, path), 1024 * 1024);
      if (!file || file.fileSize > file.bytes.length) continue;
      const parsed = JSON.parse(file.bytes.toString("utf8"));
      for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const value = parsed[key];
        if (value && typeof value === "object" && !Array.isArray(value)) count += Object.keys(value).length;
      }
    } catch {
    }
  }
  return count;
}
async function dirtyFileCount(root, timeout) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "-uno"], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout.split(/\r?\n/u).filter(Boolean).length;
  } catch {
    return 0;
  }
}
function deterministicSample(values, limit) {
  if (values.length <= limit) return values;
  const result = [];
  const stride = values.length / limit;
  for (let index = 0; index < limit; index += 1) {
    const item = values[Math.floor(index * stride)];
    if (item !== void 0) result.push(item);
  }
  return result;
}
async function profileRepository(cwd = process.cwd(), options = {}) {
  const maxFiles = options.maxFiles ?? 5e4;
  const maxSampleFiles = options.maxSampleFiles ?? 500;
  const gitTimeoutMs = options.gitTimeoutMs ?? 1200;
  const maxFileBytes = options.maxFileBytes ?? 128 * 1024;
  const readConcurrency = options.readConcurrency ?? 12;
  const deadline = Date.now() + (options.budgetMs ?? 5e3);
  const resolvedCwd = resolve(cwd);
  const remainingTimeout = () => Math.max(50, Math.min(gitTimeoutMs, deadline - Date.now()));
  const discoveredRoot = await gitRoot(resolvedCwd, remainingTimeout());
  const root = discoveredRoot ?? resolvedCwd;
  const trackedFiles = discoveredRoot && Date.now() < deadline ? await gitFiles(root, remainingTimeout()) : null;
  const fallback = trackedFiles ? null : await filesystemFiles(root, maxFiles, deadline);
  const allFiles = (trackedFiles ?? fallback?.files ?? []).slice(0, maxFiles);
  const truncated = Boolean(fallback?.truncated) || (trackedFiles?.length ?? 0) > maxFiles;
  const codeFiles = allFiles.filter((path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] !== void 0);
  const sample = deterministicSample(codeFiles, maxSampleFiles);
  const lineCounts = await mapWithConcurrency(
    sample,
    readConcurrency,
    deadline,
    (path) => countLines(join(root, path), maxFileBytes)
  );
  const validLineCounts = lineCounts.filter((value) => value !== null);
  const sampledLines = validLineCounts.reduce((sum, lines) => sum + lines, 0);
  const linesOfCode = validLineCounts.length === 0 ? 0 : Math.round(sampledLines * codeFiles.length / validLineCounts.length);
  const languages = new Set(codeFiles.map((path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]).filter(Boolean));
  const packageFiles = allFiles.filter((path) => /(?:^|\/)package\.json$/u.test(path));
  return {
    root,
    source: trackedFiles ? "git" : "filesystem",
    fileCount: allFiles.length,
    linesOfCode,
    testFileCount: allFiles.filter((path) => TEST_FILE_PATTERN.test(path)).length,
    languageCount: languages.size,
    dependencyCount: await sumDependencies(root, packageFiles, deadline),
    packageCount: packageFiles.length,
    dirtyFileCount: trackedFiles && Date.now() < deadline ? await dirtyFileCount(root, remainingTimeout()) : 0,
    sampledCodeFiles: validLineCounts.length,
    truncated: truncated || validLineCounts.length < sample.length || Date.now() >= deadline
  };
}

// src/store.ts
import { createHash, createHmac, randomBytes } from "crypto";
import { appendFile, chmod, mkdir, open as open2, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join as join2, resolve as resolve2, sep as sep2 } from "path";
var SCHEMA_VERSION = 1;
var HISTORY_FILENAME = "runs.jsonl";
var SALT_FILENAME = ".install-salt";
var SALT_LOCK_FILENAME = ".install-salt.lock";
var LOCK_FILENAME = ".runs.lock";
var PROFILE_DIRECTORY = "profiles";
var LOCK_STALE_MS = 1e4;
var PROFILE_CACHE_MS = 10 * 6e4;
var SALT_BYTES = 32;
var MAX_HISTORY_LINE_LENGTH = 16 * 1024;
var MAX_MODEL_LENGTH = 80;
var MAX_FORMATTED_DURATION_LENGTH = 64;
var MAX_CONFIDENCE_REASON_LENGTH = 512;
var PROVIDERS = ["codex", "claude"];
var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
var SPEEDS = ["standard", "fast"];
var TASK_CLASSES = ["question", "research", "review", "diagnose", "bugfix", "feature", "refactor", "migration"];
var SCOPES = ["micro", "small", "medium", "large", "project"];
var AMBIGUITIES = ["low", "medium", "high"];
var CONFIDENCE_LEVELS = ["low", "medium", "high"];
var PRIVATE_KEY_PATTERN = /^[a-f0-9]{32}$/u;
function positiveFinite(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function median2(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle];
  if (current === void 0) return null;
  if (sorted.length % 2 === 1) return current;
  const previous = sorted[middle - 1];
  return previous === void 0 ? current : (current + previous) / 2;
}
function round(value, digits = 2) {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
function isOneOf(value, allowedValues) {
  return typeof value === "string" && allowedValues.some((candidate) => candidate === value);
}
function isBoundedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function isPrivateKey(value) {
  return typeof value === "string" && PRIVATE_KEY_PATTERN.test(value);
}
function isCanonicalDate(value) {
  if (!isBoundedString(value, 32)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function isNonnegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function isNonnegativeInteger(value) {
  return isNonnegativeFiniteNumber(value) && Number.isSafeInteger(value);
}
function isStoredPrompt(value) {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "characters",
    "words",
    "lines",
    "checklistItems",
    "taskClass",
    "scope",
    "ambiguity",
    "external",
    "tests",
    "browser",
    "deploy",
    "destructive"
  ])) return false;
  return isNonnegativeInteger(value.characters) && isNonnegativeInteger(value.words) && isNonnegativeInteger(value.lines) && isNonnegativeInteger(value.checklistItems) && isOneOf(value.taskClass, TASK_CLASSES) && isOneOf(value.scope, SCOPES) && isOneOf(value.ambiguity, AMBIGUITIES) && typeof value.external === "boolean" && typeof value.tests === "boolean" && typeof value.browser === "boolean" && typeof value.deploy === "boolean" && typeof value.destructive === "boolean";
}
function isStoredRepository(value) {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "fileCount",
    "linesOfCode",
    "testFileCount",
    "languageCount",
    "dependencyCount",
    "packageCount",
    "dirtyFileCount"
  ])) return false;
  return [
    value.fileCount,
    value.linesOfCode,
    value.testFileCount,
    value.languageCount,
    value.dependencyCount,
    value.packageCount,
    value.dirtyFileCount
  ].every(isNonnegativeInteger);
}
function isStoredFeatures(value) {
  if (!isObject(value) || !hasOnlyKeys(value, ["provider", "model", "effort", "speed", "prompt", "repo"])) return false;
  return isOneOf(value.provider, PROVIDERS) && isBoundedString(value.model, MAX_MODEL_LENGTH) && isOneOf(value.effort, EFFORTS) && isOneOf(value.speed, SPEEDS) && isStoredPrompt(value.prompt) && isStoredRepository(value.repo);
}
function isStoredEstimate(value) {
  if (!isObject(value) || !hasOnlyKeys(value, ["minutes", "formatted", "confidence"])) return false;
  if (!isObject(value.minutes) || !hasOnlyKeys(value.minutes, ["p25", "p50", "p80", "p95", "expected"])) return false;
  if (!isObject(value.formatted) || !hasOnlyKeys(value.formatted, ["p50", "p80"])) return false;
  if (!isObject(value.confidence) || !hasOnlyKeys(value.confidence, ["level", "spread", "reason"])) return false;
  const { p25, p50, p80, p95, expected } = value.minutes;
  return [p25, p50, p80, p95, expected].every(isNonnegativeFiniteNumber) && p25 <= p50 && p50 <= p80 && p80 <= p95 && isBoundedString(value.formatted.p50, MAX_FORMATTED_DURATION_LENGTH) && isBoundedString(value.formatted.p80, MAX_FORMATTED_DURATION_LENGTH) && isOneOf(value.confidence.level, CONFIDENCE_LEVELS) && isNonnegativeFiniteNumber(value.confidence.spread) && isBoundedString(value.confidence.reason, MAX_CONFIDENCE_REASON_LENGTH);
}
function isRunRecord(value) {
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION || !isPrivateKey(value.runId)) return false;
  if (value.kind === "started") {
    if (!hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "runId",
      "sessionKey",
      "turnKey",
      "repoKey",
      "source",
      "startedAt",
      "features",
      "estimate"
    ])) return false;
    return isPrivateKey(value.sessionKey) && (!Object.hasOwn(value, "turnKey") || isPrivateKey(value.turnKey)) && isPrivateKey(value.repoKey) && isOneOf(value.source, ["hook", "import"]) && isCanonicalDate(value.startedAt) && isStoredFeatures(value.features) && isStoredEstimate(value.estimate);
  }
  if (value.kind === "completed") {
    if (!hasOnlyKeys(value, ["schemaVersion", "kind", "runId", "completedAt", "elapsedMs", "outcome"])) return false;
    return isCanonicalDate(value.completedAt) && isNonnegativeInteger(value.elapsedMs) && isOneOf(value.outcome, ["success", "failed", "censored"]);
  }
  return false;
}
function isCachedProfile(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  const profile = candidate.profile;
  if (!isCanonicalDate(candidate.savedAt) || !profile) return false;
  if (profile.source !== "git" && profile.source !== "filesystem") return false;
  return [
    profile.fileCount,
    profile.linesOfCode,
    profile.testFileCount,
    profile.languageCount,
    profile.dependencyCount,
    profile.packageCount,
    profile.dirtyFileCount,
    profile.sampledCodeFiles
  ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0) && typeof profile.truncated === "boolean";
}
function resolvePluginDataDir(options = {}) {
  if (options.dataDir) return resolve2(options.dataDir);
  const env = options.env ?? process.env;
  const configured = env.CODEX_PLUGIN_DATA ?? env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA ?? env.AGENT_ETA_DATA_DIR;
  if (configured) return resolve2(configured);
  const cwd = resolve2(options.cwd ?? process.cwd());
  const parts = cwd.split(sep2);
  const pluginsIndex = parts.lastIndexOf("plugins");
  if (pluginsIndex > 0 && parts[pluginsIndex + 1] === "cache" && parts[pluginsIndex + 3] === "agent-eta" && parts[pluginsIndex + 2]) {
    const codexHome = parts.slice(0, pluginsIndex).join(sep2) || sep2;
    return resolve2(codexHome, "plugins", "data", `agent-eta-${parts[pluginsIndex + 2]}`);
  }
  const xdgData = env.XDG_DATA_HOME;
  return resolve2(xdgData ? join2(xdgData, "agent-eta") : join2(homedir(), ".agent-eta"));
}
var CalibrationStore = class {
  dataDir;
  historyPath;
  salt = null;
  constructor(options = {}) {
    this.dataDir = resolvePluginDataDir(options);
    this.historyPath = join2(this.dataDir, HISTORY_FILENAME);
  }
  async ensureDirectory() {
    await mkdir(this.dataDir, { recursive: true, mode: 448 });
    await chmod(this.dataDir, 448).catch(() => void 0);
  }
  async readValidSalt(path) {
    try {
      const salt = await readFile(path);
      return salt.length === SALT_BYTES ? salt : null;
    } catch {
      return null;
    }
  }
  async getSalt() {
    if (this.salt) return this.salt;
    await this.ensureDirectory();
    const saltPath = join2(this.dataDir, SALT_FILENAME);
    const existing = await this.readValidSalt(saltPath);
    if (existing) {
      await chmod(saltPath, 384).catch(() => void 0);
      this.salt = existing;
      return existing;
    }
    const installed = await this.withFileLock(SALT_LOCK_FILENAME, "Agent ETA salt store is busy", async () => {
      const winner = await this.readValidSalt(saltPath);
      if (winner) {
        await chmod(saltPath, 384).catch(() => void 0);
        return winner;
      }
      const candidate = randomBytes(SALT_BYTES);
      const temporaryPath = join2(
        this.dataDir,
        `${SALT_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
      );
      try {
        const handle = await open2(temporaryPath, "wx", 384);
        try {
          await handle.writeFile(candidate);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporaryPath, saltPath);
        } catch {
          await unlink(saltPath).catch(() => void 0);
          await rename(temporaryPath, saltPath);
        }
        await chmod(saltPath, 384).catch(() => void 0);
      } finally {
        await unlink(temporaryPath).catch(() => void 0);
      }
      const published = await this.readValidSalt(saltPath);
      if (!published) throw new Error("Agent ETA could not initialize its private salt");
      return published;
    });
    this.salt = installed;
    return installed;
  }
  async privateKey(value) {
    const salt = await this.getSalt();
    return createHmac("sha256", salt).update(value).digest("hex").slice(0, 32);
  }
  async cachedRepositoryProfile(identity, maxAgeMs = PROFILE_CACHE_MS) {
    const cacheKey = await this.privateKey(`profile:${identity}`);
    try {
      const parsed = JSON.parse(
        await readFile(join2(this.dataDir, PROFILE_DIRECTORY, `${cacheKey}.json`), "utf8")
      );
      if (!isCachedProfile(parsed)) return null;
      if (Date.now() - Date.parse(parsed.savedAt) > maxAgeMs) return null;
      return { root: resolve2(identity), ...parsed.profile };
    } catch {
      return null;
    }
  }
  async cacheRepositoryProfile(identity, profile) {
    const cacheKey = await this.privateKey(`profile:${identity}`);
    const directory = join2(this.dataDir, PROFILE_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 448 });
    await chmod(directory, 448).catch(() => void 0);
    const derivedProfile = {
      source: profile.source,
      fileCount: profile.fileCount,
      linesOfCode: profile.linesOfCode,
      testFileCount: profile.testFileCount,
      languageCount: profile.languageCount,
      dependencyCount: profile.dependencyCount,
      packageCount: profile.packageCount,
      dirtyFileCount: profile.dirtyFileCount,
      sampledCodeFiles: profile.sampledCodeFiles,
      truncated: profile.truncated
    };
    const path = join2(directory, `${cacheKey}.json`);
    await writeFile(path, JSON.stringify({ savedAt: (/* @__PURE__ */ new Date()).toISOString(), profile: derivedProfile }), {
      encoding: "utf8",
      mode: 384
    });
    await chmod(path, 384).catch(() => void 0);
  }
  async append(record) {
    if (!isRunRecord(record)) throw new Error("Refusing to persist an invalid Agent ETA run record");
    await this.ensureDirectory();
    await appendFile(this.historyPath, `${JSON.stringify(record)}
`, { encoding: "utf8", mode: 384 });
    await chmod(this.historyPath, 384).catch(() => void 0);
  }
  async records() {
    try {
      const contents = await readFile(this.historyPath, "utf8");
      const records = [];
      for (const line of contents.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        if (line.length > MAX_HISTORY_LINE_LENGTH) continue;
        try {
          const parsed = JSON.parse(line);
          if (isRunRecord(parsed)) records.push(parsed);
        } catch {
        }
      }
      return records;
    } catch {
      return [];
    }
  }
  async withFileLock(filename, busyMessage, operation) {
    await this.ensureDirectory();
    const lockPath = join2(this.dataDir, filename);
    const deadline = Date.now() + 1e3;
    while (true) {
      try {
        const handle = await open2(lockPath, "wx", 384);
        await handle.close();
        break;
      } catch {
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
        } catch {
        }
        if (Date.now() >= deadline) throw new Error(busyMessage);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await unlink(lockPath).catch(() => void 0);
    }
  }
  async withLock(operation) {
    return this.withFileLock(LOCK_FILENAME, "Agent ETA store is busy", operation);
  }
  async startRun(input) {
    const startedAt = input.startedAt ?? /* @__PURE__ */ new Date();
    const sessionKey = await this.privateKey(`session:${input.sessionId}`);
    const turnKey = input.turnId ? await this.privateKey(`turn:${input.sessionId}:${input.turnId}`) : void 0;
    const repoKey = await this.privateKey(`repo:${input.repoIdentity}`);
    const runIdentity = input.identityHint ?? [input.sessionId, input.turnId ?? "", startedAt.toISOString()].join(":");
    const runId = await this.privateKey(`run:${runIdentity}`);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      kind: "started",
      runId,
      sessionKey,
      ...turnKey ? { turnKey } : {},
      repoKey,
      source: input.source ?? "hook",
      startedAt: startedAt.toISOString(),
      features: input.features,
      estimate: input.estimate
    };
    await this.withLock(async () => {
      const records = await this.records();
      if (records.some((candidate) => candidate.kind === "started" && candidate.runId === runId)) return;
      const completedIds = new Set(
        records.filter((candidate) => candidate.kind === "completed").map((candidate) => candidate.runId)
      );
      const abandoned = records.filter(
        (candidate) => candidate.kind === "started" && candidate.sessionKey === sessionKey && !completedIds.has(candidate.runId)
      );
      for (const previous of abandoned) {
        await this.append({
          schemaVersion: SCHEMA_VERSION,
          kind: "completed",
          runId: previous.runId,
          completedAt: startedAt.toISOString(),
          elapsedMs: Math.max(0, startedAt.getTime() - Date.parse(previous.startedAt)),
          outcome: "censored"
        });
      }
      await this.append(record);
    });
    return record;
  }
  async completeRun(input) {
    const sessionKey = await this.privateKey(`session:${input.sessionId}`);
    const turnKey = input.turnId ? await this.privateKey(`turn:${input.sessionId}:${input.turnId}`) : void 0;
    return this.withLock(async () => {
      const records = await this.records();
      const completedIds = new Set(
        records.filter((record) => record.kind === "completed").map((record) => record.runId)
      );
      const activeRuns = records.filter(
        (record) => record.kind === "started" && record.sessionKey === sessionKey && !completedIds.has(record.runId) && (!turnKey || record.turnKey === turnKey)
      );
      const selected = input.completeAll ? activeRuns : activeRuns.slice(-1);
      if (selected.length === 0) return { record: null, records: [], created: false };
      const completedAt = input.completedAt ?? /* @__PURE__ */ new Date();
      const completedRecords = selected.map((active) => ({
        schemaVersion: SCHEMA_VERSION,
        kind: "completed",
        runId: active.runId,
        completedAt: completedAt.toISOString(),
        elapsedMs: Math.max(0, completedAt.getTime() - Date.parse(active.startedAt)),
        outcome: input.outcome
      }));
      for (const completedRecord of completedRecords) await this.append(completedRecord);
      return { record: completedRecords.at(-1) ?? null, records: completedRecords, created: true };
    });
  }
  async importRun(input) {
    const runId = await this.privateKey(`import:${input.identity}`);
    const started = {
      schemaVersion: SCHEMA_VERSION,
      kind: "started",
      runId,
      sessionKey: await this.privateKey(`session:${input.sessionIdentity}`),
      repoKey: await this.privateKey(`repo:${input.repoIdentity}`),
      source: "import",
      startedAt: input.startedAt.toISOString(),
      features: input.features,
      estimate: input.estimate
    };
    const completed = {
      schemaVersion: SCHEMA_VERSION,
      kind: "completed",
      runId,
      completedAt: input.completedAt.toISOString(),
      elapsedMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
      outcome: input.outcome
    };
    return this.withLock(async () => {
      const records = await this.records();
      if (records.some((record) => record.runId === runId)) return false;
      await this.append(started);
      await this.append(completed);
      return true;
    });
  }
  async history(limit = 50) {
    const records = await this.records();
    const completed = new Map(
      records.filter((record) => record.kind === "completed").map((record) => [record.runId, record])
    );
    return records.filter((record) => record.kind === "started").map((record) => {
      const outcome = completed.get(record.runId);
      return {
        runId: record.runId,
        repoKey: record.repoKey,
        source: record.source,
        startedAt: record.startedAt,
        completedAt: outcome?.completedAt,
        elapsedMs: outcome?.elapsedMs,
        outcome: outcome?.outcome,
        features: record.features,
        estimate: record.estimate
      };
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.max(0, limit));
  }
  async currentRun(options = {}) {
    const history = await this.history(Number.MAX_SAFE_INTEGER);
    const repoKey = options.repoIdentity ? await this.privateKey(`repo:${options.repoIdentity}`) : null;
    const cutoff = Date.now() - (options.maxAgeMs ?? 24 * 60 * 6e4);
    return history.find(
      (entry) => entry.completedAt === void 0 && Date.parse(entry.startedAt) >= cutoff && (!repoKey || entry.repoKey === repoKey)
    ) ?? null;
  }
  async calibrationStatus() {
    const history = await this.history(Number.MAX_SAFE_INTEGER);
    const completed = history.filter(
      (entry) => entry.elapsedMs !== void 0 && entry.outcome !== void 0
    );
    const successful = completed.filter((entry) => entry.outcome === "success");
    const actualMinutes = successful.map((entry) => positiveFinite(entry.elapsedMs / 6e4));
    const absoluteErrors = successful.map((entry) => Math.abs(entry.elapsedMs / 6e4 - entry.estimate.minutes.p50));
    const coverage = (quantile) => {
      if (successful.length === 0) return null;
      const inside = successful.filter((entry) => entry.elapsedMs / 6e4 <= entry.estimate.minutes[quantile]).length;
      return inside / successful.length;
    };
    return {
      state: successful.length >= 20 ? "personalized" : successful.length >= 3 ? "learning" : "cold-start",
      startedRuns: history.length,
      completedRuns: completed.length,
      successfulRuns: successful.length,
      failedRuns: completed.filter((entry) => entry.outcome === "failed").length,
      censoredRuns: completed.filter((entry) => entry.outcome === "censored").length,
      medianActualMinutes: round(median2(actualMinutes)),
      medianAbsoluteErrorMinutes: round(median2(absoluteErrors)),
      p50ObservedCoverage: round(coverage("p50"), 3),
      p80ObservedCoverage: round(coverage("p80"), 3)
    };
  }
  async calibrationSamples(limit = 200) {
    const history = await this.history(Number.MAX_SAFE_INTEGER);
    return history.filter(
      (entry) => entry.elapsedMs !== void 0 && entry.outcome === "success"
    ).slice(0, Math.max(0, limit)).map((entry) => ({
      estimatedMinutes: entry.estimate.minutes.p50,
      actualMinutes: entry.elapsedMs / 6e4,
      taskClass: entry.features.prompt.taskClass,
      provider: entry.features.provider,
      model: entry.features.model,
      effort: entry.features.effort,
      speed: entry.features.speed
    }));
  }
  async privacyFingerprint() {
    const records = await this.records();
    return createHash("sha256").update(JSON.stringify(records)).digest("hex");
  }
};

// src/hook.ts
var MAX_HOOK_INPUT_BYTES = 2 * 1024 * 1024;
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function hookEffort(value) {
  const direct = asString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  return asString(value.level);
}
function emptyProfile(cwd) {
  return {
    root: cwd,
    source: "filesystem",
    fileCount: 0,
    linesOfCode: 0,
    testFileCount: 0,
    languageCount: 0,
    dependencyCount: 0,
    packageCount: 0,
    dirtyFileCount: 0,
    sampledCodeFiles: 0,
    truncated: false
  };
}
async function safeProfile(cwd, store) {
  const cached = await store.cachedRepositoryProfile(cwd).catch(() => null);
  if (cached) return cached;
  try {
    const profile = await profileRepository(cwd, {
      gitTimeoutMs: 350,
      maxFiles: 3e4,
      maxSampleFiles: 120,
      maxFileBytes: 64 * 1024,
      readConcurrency: 8,
      budgetMs: 1100
    });
    await store.cacheRepositoryProfile(cwd, profile).catch(() => void 0);
    return profile;
  } catch {
    return emptyProfile(cwd);
  }
}
function providerFor(input, explicit, environment = process.env) {
  if (explicit) return explicit;
  const configured = asString(environment.AGENT_ETA_PROVIDER);
  if (configured) return normalizeProvider(configured, "codex");
  if (environment.CODEX_PLUGIN_ROOT || environment.PLUGIN_ROOT) return "codex";
  if (environment.CLAUDE_PLUGIN_ROOT) return "claude";
  return normalizeProvider(input.model, "codex");
}
function runtimeConfiguration(input, options) {
  const environment = options.environment ?? process.env;
  const provider = providerFor(input, options.provider, environment);
  const modelSignal = asString(environment.AGENT_ETA_MODEL) ?? asString(input.model);
  const effortSignal = asString(environment.AGENT_ETA_EFFORT) ?? asString(input.reasoning_effort) ?? hookEffort(input.effort);
  const speedSignal = asString(environment.AGENT_ETA_SPEED) ?? asString(input.speed) ?? asString(input.service_tier);
  return {
    provider,
    model: normalizeModel(modelSignal, provider),
    effort: normalizeEffort(effortSignal),
    speed: normalizeSpeed(speedSignal),
    assumed: [
      ...!modelSignal ? [`${provider}-default model`] : [],
      ...!effortSignal ? ["medium effort"] : [],
      ...!speedSignal ? ["standard speed"] : []
    ]
  };
}
function buildCoreRepo(profile) {
  return {
    fileCount: profile.fileCount,
    linesOfCode: profile.linesOfCode,
    testFileCount: profile.testFileCount,
    languageCount: profile.languageCount,
    dependencyCount: profile.dependencyCount,
    packageCount: profile.packageCount
  };
}
async function handleSubmit(input, options) {
  const prompt = asString(input.prompt);
  if (!prompt) return {};
  const { provider, model, effort, speed, assumed } = runtimeConfiguration(input, options);
  const cwd = asString(input.cwd) ?? process.cwd();
  const promptFeatures = derivePromptFeatures(prompt);
  const store = new CalibrationStore({ dataDir: options.dataDir });
  const repo = await safeProfile(cwd, store);
  const calibrationSamples = await store.calibrationSamples().catch(() => []);
  const estimate = estimateTask({
    prompt,
    provider,
    model,
    effort,
    speed,
    repo: buildCoreRepo(repo),
    taskClass: promptFeatures.taskClass,
    options: {
      scope: promptFeatures.scope,
      ambiguity: promptFeatures.ambiguity,
      external: promptFeatures.external,
      tests: promptFeatures.tests,
      browser: promptFeatures.browser,
      deploy: promptFeatures.deploy,
      destructive: promptFeatures.destructive
    },
    calibrationSamples
  });
  const now = (options.now ?? (() => /* @__PURE__ */ new Date()))();
  const sessionId = asString(input.session_id) ?? asString(input.sessionId) ?? "anonymous-session";
  const turnId = asString(input.turn_id) ?? asString(input.turnId);
  const promptFingerprint = createHash2("sha256").update(prompt).digest("hex").slice(0, 16);
  const identityHint = turnId ? `${provider}:${sessionId}:${turnId}` : `${provider}:${sessionId}:${now.toISOString()}:${promptFingerprint}`;
  try {
    await store.startRun({
      sessionId: `${provider}:${sessionId}`,
      turnId,
      repoIdentity: cwd,
      startedAt: now,
      features: toStoredFeatures({ provider, model, effort, speed, prompt: promptFeatures, repo }),
      estimate: toStoredEstimate(estimate),
      identityHint
    });
  } catch {
  }
  const assumptionNote = assumed.length ? ` \xB7 assumes ${assumed.join(" + ")} (AGENT_ETA_* can override)` : "";
  return { systemMessage: `Agent ETA \xB7 P50 ${estimate.formatted.p50} \xB7 P80 ${estimate.formatted.p80}${assumptionNote}` };
}
async function handleCompletion(input, options, outcome) {
  const provider = providerFor(input, options.provider, options.environment ?? process.env);
  const sessionId = asString(input.session_id) ?? asString(input.sessionId);
  if (!sessionId) return {};
  try {
    const store = new CalibrationStore({ dataDir: options.dataDir });
    const turnId = asString(input.turn_id) ?? asString(input.turnId);
    await store.completeRun({
      sessionId: `${provider}:${sessionId}`,
      ...turnId ? { turnId } : {},
      completedAt: (options.now ?? (() => /* @__PURE__ */ new Date()))(),
      outcome,
      completeAll: outcome === "censored"
    });
  } catch {
  }
  return {};
}
async function handleHookObject(input, options = {}) {
  const eventName = asString(input.hook_event_name);
  if (eventName === "UserPromptSubmit") return handleSubmit(input, options);
  if (eventName === "Stop") return handleCompletion(input, options, "success");
  if (eventName === "StopFailure") return handleCompletion(input, options, "failed");
  if (eventName === "SessionEnd") return handleCompletion(input, options, "censored");
  return {};
}
async function handleHookInvocation(rawInput, options = {}) {
  try {
    if (Buffer.byteLength(rawInput, "utf8") > MAX_HOOK_INPUT_BYTES) return {};
    const parsed = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return await handleHookObject(parsed, options);
  } catch {
    return {};
  }
}
async function readHookStdin(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_HOOK_INPUT_BYTES) return "";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function runHookProcess(options = {}) {
  const rawInput = await readHookStdin();
  const output = await handleHookInvocation(rawInput, options);
  process.stdout.write(`${JSON.stringify(output)}
`);
}
function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}
if (isDirectExecution()) {
  runHookProcess().catch(() => {
    process.stdout.write("{}\n");
  });
}
export {
  handleHookInvocation,
  handleHookObject,
  readHookStdin,
  runHookProcess
};
//# sourceMappingURL=hook.mjs.map