import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Clock3,
  Copy,
  FolderOpen,
  Gauge,
  LockKeyhole,
  Plus,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import {
  estimateTask,
  formatDuration,
  type CalibrationSample,
  type AmbiguityLevel,
  type Effort,
  type EstimateInput,
  type Provider,
  type RepoProfile,
  type ScopeLevel,
  type SpeedMode,
  type TaskClass,
} from '@agent-eta/core';
import { scanRepository, type ScannedRepository } from './repoScanner';
import { toLocalRunInput, type LocalRunInput } from './lib/supabase/validation';

const CloudAccount = lazy(() => import('./CloudAccount'));

type TaskFlag = 'tests' | 'browser' | 'external' | 'deploy';

type WebCalibrationSample = LocalRunInput & {
  actualMinutes: number;
  successful: boolean;
};

interface ForecastStage {
  id: string;
  label: string;
  p50: number;
  p80: number;
  share?: number;
}

interface ForecastDriver {
  label: string;
  detail?: string;
  impactMinutes?: number;
}

interface ForecastView {
  quantiles: { p25: number; p50: number; p80: number; p95: number };
  stages: ForecastStage[];
  analysis: {
    taskClass: TaskClass;
    scope?: ScopeLevel;
    scopeScore?: number;
    ambiguity?: AmbiguityLevel;
    signals?: {
      tests?: boolean;
      browser?: boolean;
      external?: boolean;
      deploy?: boolean;
      destructive?: boolean;
    };
  };
  drivers: Array<ForecastDriver | string>;
  confidence: { level: string; score?: number } | string;
  calibration: { sampleCount?: number; multiplier?: number };
}

function ReturnWindowMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`return-window-mark ${className}`.trim()}
      viewBox="0 0 64 32"
      aria-hidden="true"
      focusable="false"
    >
      <path className="mark-baseline" d="M5 16H59" />
      <path className="mark-window" d="M9 16H44" />
      <path className="mark-tail" d="M44 16H59" />
      <circle className="mark-about" cx="29" cy="16" r="5" />
      <path className="mark-allow" d="M44 6V26M44 6H49M44 26H49" />
    </svg>
  );
}

const STORAGE_KEY = 'agent-eta-calibration-v1';

const MODELS: Record<Provider, Array<{ id: string; label: string; supportsFast: boolean }>> = {
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', supportsFast: true },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', supportsFast: true },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', supportsFast: true },
    { id: 'gpt-5.5', label: 'GPT-5.5', supportsFast: true },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', supportsFast: true },
    { id: 'gpt-5.3-codex-spark', label: 'Codex Spark', supportsFast: false },
  ],
  claude: [
    { id: 'sonnet', label: 'Claude Sonnet 5', supportsFast: false },
    { id: 'opus', label: 'Claude Opus 5', supportsFast: true },
    { id: 'fable', label: 'Claude Fable 5', supportsFast: false },
    { id: 'haiku', label: 'Claude Haiku', supportsFast: false },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', supportsFast: true },
  ],
};

const QUICK_REPOS: Array<{ label: string; profile: ScannedRepository }> = [
  {
    label: 'Small',
    profile: {
      name: 'Small app',
      files: 120,
      lines: 12_000,
      packages: 1,
      testFiles: 12,
      sourceBytes: 780_000,
      languages: ['TypeScript'],
      monorepo: false,
      dirtyFiles: 0,
    },
  },
  {
    label: 'Medium',
    profile: {
      name: 'Medium product',
      files: 680,
      lines: 74_000,
      packages: 2,
      testFiles: 68,
      sourceBytes: 4_900_000,
      languages: ['TypeScript', 'SQL'],
      monorepo: false,
      dirtyFiles: 0,
    },
  },
  {
    label: 'Large',
    profile: {
      name: 'Large monorepo',
      files: 4_800,
      lines: 620_000,
      packages: 18,
      testFiles: 510,
      sourceBytes: 41_000_000,
      languages: ['TypeScript', 'Go', 'SQL'],
      monorepo: true,
      dirtyFiles: 0,
    },
  },
];

const DEFAULT_PROMPT =
  'Add Google sign-in, test the complete flow in the browser, and deploy it to production.';

function loadSamples(): WebCalibrationSample[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      const result = toLocalRunInput(candidate);
      if (!result.ok || result.value.actualMinutes === undefined) return [];
      return [{
        ...result.value,
        actualMinutes: result.value.actualMinutes,
        successful: result.value.successful === true,
      }];
    });
  } catch {
    return [];
  }
}

function toClock(minutesFromNow: number): string {
  const time = new Date(Date.now() + Math.max(0, minutesFromNow) * 60_000);
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(time);
}

function taskClassLabel(taskClass: string): string {
  return taskClass
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeForecast(result: unknown): ForecastView {
  const value = result as Record<string, any>;
  const quantiles = value.minutes || {};
  return {
    quantiles: {
      p25: Number(quantiles.p25 ?? value.p25 ?? 4),
      p50: Number(quantiles.p50 ?? value.p50 ?? 8),
      p80: Number(quantiles.p80 ?? value.p80 ?? 14),
      p95: Number(quantiles.p95 ?? value.p95 ?? 22),
    },
    stages: Array.isArray(value.stages)
      ? value.stages.map((stage: Record<string, any>) => ({
          id: String(stage.stage),
          label: String(stage.label),
          p50: Number(stage.minutes?.p50 ?? 0),
          p80: Number(stage.minutes?.p80 ?? 0),
          share: Number(stage.shareOfP50 ?? 0),
        }))
      : [],
    analysis: value.analysis || {
      taskClass: value.taskClass || 'implementation',
      scopeScore: value.scopeScore,
    },
    drivers: Array.isArray(value.drivers) ? value.drivers : [],
    confidence: value.confidence || { level: 'Learning' },
    calibration: value.calibration || {},
  };
}

function repoToCore(repo: ScannedRepository | null): RepoProfile | undefined {
  if (!repo) return undefined;
  return {
    fileCount: repo.files,
    linesOfCode: repo.lines,
    packageCount: repo.packages,
    testFileCount: repo.testFiles,
    languageCount: repo.languages.length,
  } as RepoProfile;
}

function ForecastRail({ forecast }: { forecast: ForecastView }) {
  const { p25, p50, p80, p95 } = forecast.quantiles;
  const ceiling = Math.max(p95 * 1.08, 1);
  const position = (value: number) => `${Math.min(96, Math.max(2, (value / ceiling) * 100))}%`;

  return (
    <div className="forecast-rail" aria-label={`About ${formatDuration(p50)}, allow up to ${formatDuration(p80)}`}>
      <div className="rail-label rail-label-start">now</div>
      <div className="rail-label rail-label-tail" style={{ left: position(p95) }}>
        tail
      </div>
      <div className="rail-track" />
      <div
        className="rail-window"
        style={{ left: position(p25), width: `calc(${position(p80)} - ${position(p25)})` }}
      />
      <div
        className="rail-tail"
        style={{ left: position(p80), width: `calc(${position(p95)} - ${position(p80)})` }}
      />
      <div className="rail-marker rail-marker-p50" style={{ left: position(p50) }}>
        <span>about</span>
      </div>
      <div className="rail-marker rail-marker-p80" style={{ left: position(p80) }}>
        <span>allow</span>
      </div>
    </div>
  );
}

function App() {
  const [provider, setProvider] = useState<Provider>('codex');
  const [model, setModel] = useState(MODELS.codex[0]!.id);
  const [effort, setEffort] = useState<Effort>('high');
  const [speed, setSpeed] = useState<SpeedMode>('standard');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [repo, setRepo] = useState<ScannedRepository | null>(QUICK_REPOS[1]!.profile);
  const [repoSource, setRepoSource] = useState('Medium preset');
  const [scanning, setScanning] = useState(false);
  const [flags, setFlags] = useState<Record<TaskFlag, boolean>>({
    tests: false,
    browser: false,
    external: false,
    deploy: false,
  });
  const [samples, setSamples] = useState<WebCalibrationSample[]>(loadSamples);
  const [actualOpen, setActualOpen] = useState(false);
  const [actualMinutes, setActualMinutes] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const directoryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes('access_token=') || !hash.includes('refresh_token=')) return;
    void import('./lib/supabase/auth').then(({ bootstrapOAuthCallback }) => {
      const callback = bootstrapOAuthCallback();
      if (!callback) return;
      void callback.then((result) => {
        if (result && !result.ok) setToast(result.message);
      });
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
  }, [samples]);

  useEffect(() => {
    const available = MODELS[provider];
    setModel(available[0]!.id);
    setSpeed('standard');
  }, [provider]);

  const forecast = useMemo(() => {
    const input = {
      prompt,
      provider,
      model,
      effort,
      speed,
      repo: repoToCore(repo),
      options: {
        ...(flags.tests ? { tests: true } : {}),
        ...(flags.browser ? { browser: true } : {}),
        ...(flags.external ? { external: true } : {}),
        ...(flags.deploy ? { deploy: true } : {}),
      },
      calibrationSamples: samples as unknown as CalibrationSample[],
    } as EstimateInput;

    return normalizeForecast(estimateTask(input));
  }, [effort, flags, model, prompt, provider, repo, samples, speed]);

  const confidenceLevel =
    typeof forecast.confidence === 'string' ? forecast.confidence : forecast.confidence.level;
  const supportsFast = MODELS[provider].find((item) => item.id === model)?.supportsFast ?? false;
  const selectedModelLabel = MODELS[provider].find((item) => item.id === model)?.label ?? model;

  const driverItems = forecast.drivers.slice(0, 3).map((driver, index) => {
    if (typeof driver === 'string') return { label: driver, detail: '', impactMinutes: undefined, index };
    return { ...driver, index };
  });

  const maxStage = Math.max(...forecast.stages.map((stage) => stage.p50), 1);

  async function handleFolder(files: FileList | null) {
    if (!files?.length) return;
    setScanning(true);
    try {
      const profile = await scanRepository(files);
      setRepo(profile);
      setRepoSource('Analyzed locally');
      setToast(`${profile.name} analyzed. No files were uploaded.`);
    } finally {
      setScanning(false);
      if (directoryInput.current) directoryInput.current.value = '';
    }
  }

  function selectQuickRepo(index: number) {
    const selected = QUICK_REPOS[index]!;
    setRepo(selected.profile);
    setRepoSource(`${selected.label} preset`);
  }

  async function copyText(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_600);
  }

  async function recordActual(event: React.FormEvent) {
    event.preventDefault();
    const actual = Number(actualMinutes);
    if (!Number.isFinite(actual) || actual <= 0) return;

    const sample: WebCalibrationSample = {
      id: crypto.randomUUID(),
      provider,
      model,
      effort,
      speed,
      taskClass: forecast.analysis.taskClass,
      ...(forecast.analysis.scope ? { scope: forecast.analysis.scope } : {}),
      ...(forecast.analysis.ambiguity ? { ambiguity: forecast.analysis.ambiguity } : {}),
      tests: forecast.analysis.signals?.tests === true,
      browser: forecast.analysis.signals?.browser === true,
      external: forecast.analysis.signals?.external === true,
      deploy: forecast.analysis.signals?.deploy === true,
      destructive: forecast.analysis.signals?.destructive === true,
      estimatedP25Minutes: forecast.quantiles.p25,
      estimatedMinutes: forecast.quantiles.p50,
      estimatedP80Minutes: forecast.quantiles.p80,
      estimatedP95Minutes: forecast.quantiles.p95,
      actualMinutes: actual,
      successful: true,
      createdAt: new Date().toISOString(),
    };
    setSamples((current) => [...current, sample]);
    setActualOpen(false);
    setActualMinutes('');
    setToast('Run saved locally. Similar forecasts are now personalized.');

    const { syncNewPrivateRun } = await import('./lib/supabase/sync');
    const synced = await syncNewPrivateRun(sample);
    if (synced.ok) {
      if (synced.data.contribution.status === 'contributed') {
        setToast('Run synced privately and added to grouped benchmarks.');
      } else if (synced.data.contribution.status === 'failed') {
        setToast('Run synced privately. Benchmark contribution needs a retry.');
      } else {
        setToast('Run saved locally and synced privately.');
      }
    } else if (synced.kind === 'remote' || synced.kind === 'validation') {
      setToast('Run saved locally. Cloud sync is temporarily unavailable.');
    }
  }

  function clearLocalHistory() {
    setSamples([]);
    setToast('Local calibration history cleared.');
  }

  const estimateSummary = `⏱ About ${formatDuration(forecast.quantiles.p50)} · allow up to ${formatDuration(forecast.quantiles.p80)}`;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#estimator">Skip to estimator</a>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Agent ETA home">
          <ReturnWindowMark className="wordmark-mark" />
          <span>agent/eta</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#method">Method</a>
          <a href="#install">Install</a>
          <button className="nav-account" type="button" onClick={() => setAccountOpen(true)} aria-haspopup="dialog">
            <LockKeyhole size={14} aria-hidden="true" /> Account
          </button>
          <a className="nav-source" href="https://github.com/danielsinewe/AgentEstimate" target="_blank" rel="noreferrer">
            Source <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-kicker"><span /> Forecasting for coding agents</div>
          <h1 id="hero-title">Know before<br /><em>you delegate.</em></h1>
          <p>Paste the job. Get a planning range. Your estimates learn from every run—locally.</p>
          <a className="hero-jump" href="#estimator">Build a forecast <span>↓</span></a>
          <div className="hero-brand-mark" aria-hidden="true">
            <ReturnWindowMark />
            <span>About</span>
            <span>Allow</span>
          </div>
        </section>

        <section className="estimator-section" id="estimator" aria-label="Task duration estimator">
          <div className="estimator-grid">
            <div className="input-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-number">01</span>
                  <h2>New forecast</h2>
                </div>
                <span className="privacy-note"><LockKeyhole size={14} /> Local by default</span>
              </div>

              <label className="field-label" htmlFor="task-prompt">What are you handing off?</label>
              <div className="prompt-wrap">
                <textarea
                  id="task-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder="Describe the outcome, constraints, and how it should be verified…"
                />
                <span className="prompt-count">{prompt.trim().split(/\s+/).filter(Boolean).length} words</span>
              </div>

              <div className="control-block">
                <span className="field-label">Agent</span>
                <div className="segmented segmented-provider" role="group" aria-label="Coding agent">
                  {(['codex', 'claude'] as Provider[]).map((item) => (
                    <button
                      key={item}
                      className={provider === item ? 'active' : ''}
                      onClick={() => setProvider(item)}
                      type="button"
                      aria-pressed={provider === item}
                    >
                      {item === 'codex' ? 'Codex' : 'Claude Code'}
                    </button>
                  ))}
                </div>
              </div>

              <details className="refine-panel">
                <summary>
                  <span>Refine estimate</span>
                  <small>{selectedModelLabel} · {taskClassLabel(effort)}</small>
                </summary>
                <div className="refine-body">
                  <div className="config-row">
                    <label>
                      <span className="field-label">Model</span>
                      <select
                        value={model}
                        onChange={(event) => {
                          const nextModel = event.target.value;
                          setModel(nextModel);
                          if (!MODELS[provider].find((item) => item.id === nextModel)?.supportsFast) setSpeed('standard');
                        }}
                      >
                        {MODELS[provider].map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="field-label">Effort</span>
                      <select value={effort} onChange={(event) => setEffort(event.target.value as Effort)}>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">X-high</option>
                        <option value="max">Max</option>
                      </select>
                    </label>
                    <label>
                      <span className="field-label">Speed</span>
                      <select value={speed} onChange={(event) => setSpeed(event.target.value as SpeedMode)}>
                        <option value="standard">Standard</option>
                        <option value="fast" disabled={!supportsFast}>Fast</option>
                      </select>
                    </label>
                  </div>

                  <div className="repo-block">
                    <div className="repo-heading">
                      <div>
                        <span className="field-label">Repository</span>
                        <strong>{repo?.name || 'No repository profile'}</strong>
                      </div>
                      <button className="folder-button" type="button" onClick={() => directoryInput.current?.click()} disabled={scanning}>
                        <FolderOpen size={16} /> {scanning ? 'Reading…' : 'Choose folder'}
                      </button>
                      <input
                        ref={directoryInput}
                        className="visually-hidden"
                        type="file"
                        // @ts-expect-error Chromium directory selection is intentionally used when available.
                        webkitdirectory=""
                        multiple
                        onChange={(event) => void handleFolder(event.target.files)}
                        tabIndex={-1}
                      />
                    </div>
                    <div className="repo-meta">
                      <span>{repo?.files.toLocaleString() || 0} files</span>
                      <span>{repo?.lines ? `${repo.locSampled ? '~' : ''}${Math.round(repo.lines / 1000)}k LOC` : 'LOC unknown'}</span>
                      <span>{repo?.languages.slice(0, 2).join(' + ') || 'Any stack'}</span>
                      <span>{repoSource}</span>
                    </div>
                    <div className="quick-repos" aria-label="Repository size presets">
                      {QUICK_REPOS.map((item, index) => (
                        <button
                          key={item.label}
                          type="button"
                          onClick={() => selectQuickRepo(index)}
                          aria-pressed={repoSource === `${item.label} preset`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <p>Measured here. Never uploaded.</p>
                  </div>

                  <div className="scope-block">
                    <span className="field-label">Extra loops</span>
                    <div className="scope-flags">
                      {(
                        [
                          ['tests', 'Tests'],
                          ['browser', 'Browser'],
                          ['external', 'External service'],
                          ['deploy', 'Deploy'],
                        ] as Array<[TaskFlag, string]>
                      ).map(([key, label]) => (
                        <button
                          type="button"
                          key={key}
                          onClick={() => setFlags((current) => ({ ...current, [key]: !current[key] }))}
                          className={flags[key] ? 'active' : ''}
                          aria-pressed={flags[key]}
                        >
                          {flags[key] && <Check size={13} />} {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </details>
            </div>

            <aside className="result-panel" aria-live="polite">
              <div className="result-topline">
                <span><span className="live-dot" /> Live forecast</span>
                <span>{taskClassLabel(forecast.analysis.taskClass)}</span>
              </div>
              <div className="ready-block">
                <span>About → allow until</span>
                <div className="ready-time">
                  <strong>{toClock(forecast.quantiles.p50)}</strong>
                  <i>—</i>
                  <strong>{toClock(forecast.quantiles.p80)}</strong>
                </div>
                <div className="ready-meta">
                  <span>About <b>{formatDuration(forecast.quantiles.p50)}</b></span>
                  <span>Allow up to <b>{formatDuration(forecast.quantiles.p80)}</b></span>
                </div>
              </div>

              <ForecastRail forecast={forecast} />

              <div className="forecast-status">
                <span className="confidence-pill"><Gauge size={15} /> {taskClassLabel(confidenceLevel)} input clarity</span>
                {samples.length ? (
                  <button className="reset-history" type="button" onClick={clearLocalHistory}>
                    Reset {samples.length} local run{samples.length === 1 ? '' : 's'}
                  </button>
                ) : (
                  <span>Broad cold-start range</span>
                )}
              </div>

              <div className="result-section result-drivers">
                <div className="result-section-title">
                  <h3>Why this range</h3>
                  <span>Top drivers</span>
                </div>
                <ol>
                  {driverItems.length ? driverItems.map((driver) => (
                    <li key={`${driver.label}-${driver.index}`}>
                      <span>{String(driver.index + 1).padStart(2, '0')}</span>
                      <div>
                        <strong>{driver.label}</strong>
                        {driver.detail && <small>{driver.detail}</small>}
                      </div>
                      {typeof driver.impactMinutes === 'number' && (
                        <b>{driver.impactMinutes >= 0 ? '+' : '−'}{formatDuration(Math.abs(driver.impactMinutes))}</b>
                      )}
                    </li>
                  )) : (
                    <li><span>01</span><div><strong>Task scope</strong><small>Prompt-derived prior</small></div></li>
                  )}
                </ol>
              </div>

              <div className="result-section stage-section">
                <div className="result-section-title">
                  <h3>Expected path</h3>
                  <span>About</span>
                </div>
                <div className="stages">
                  {forecast.stages.map((stage) => (
                    <div className="stage-row" key={stage.id}>
                      <span>{stage.label}</span>
                      <div><i style={{ width: `${Math.max(6, (stage.p50 / maxStage) * 100)}%` }} /></div>
                      <b>{formatDuration(stage.p50)}</b>
                    </div>
                  ))}
                </div>
              </div>

              <div className="result-actions">
                <button className="primary-action" type="button" onClick={() => setActualOpen(true)}>
                  <Plus size={16} /> Add actual time
                </button>
                <button className="icon-action" type="button" onClick={() => void copyText('estimate', estimateSummary)} aria-label="Copy estimate">
                  {copied === 'estimate' ? <Check size={17} /> : <Copy size={17} />}
                </button>
              </div>
              <p className="result-caveat">Return-time forecast—not a correctness score.</p>
            </aside>
          </div>
        </section>

        <section className="method-section" id="method" aria-labelledby="method-title">
          <div className="section-intro">
            <span className="section-number">02</span>
            <h2 id="method-title">A range,<br /><em>not a guess.</em></h2>
            <p>Repository size is only a weak prior. Feedback loops and observed behavior matter more.</p>
          </div>
          <div className="method-grid">
            <article>
              <span>Before the run</span>
              <h3>Scope × setup</h3>
              <p>Task class, effective model and effort, expected change surface, tests, browser work, services, and deployment.</p>
            </article>
            <article>
              <span>During the run</span>
              <h3>Evidence tightens it</h3>
              <p>The plugin compares elapsed time with the original range without pretending it knows a fake completion percentage.</p>
            </article>
            <article>
              <span>After the run</span>
              <h3>Your baseline wins</h3>
              <p>Actual time recalibrates similar forecasts by agent, model, effort, and task class.</p>
            </article>
          </div>
          <div className="research-strip">
            <span>Built from primary evidence</span>
            <div>
              <a href="https://learn.chatgpt.com/docs/hooks" target="_blank" rel="noreferrer">Codex hooks <ArrowUpRight size={13} /></a>
              <a href="https://code.claude.com/docs/en/hooks" target="_blank" rel="noreferrer">Claude hooks <ArrowUpRight size={13} /></a>
              <a href="https://metr.org/time-horizons/" target="_blank" rel="noreferrer">METR time horizons <ArrowUpRight size={13} /></a>
              <a href="https://openai.com/index/introducing-codex/" target="_blank" rel="noreferrer">Codex task data <ArrowUpRight size={13} /></a>
            </div>
          </div>
        </section>

        <section className="install-section" id="install" aria-labelledby="install-title">
          <div className="install-copy">
            <span className="section-number section-number-light">03</span>
            <h2 id="install-title">Make it<br /><em>automatic.</em></h2>
            <p>One local plugin. One clean forecast at the start of every prompt.</p>
            <a className="install-link" href="https://github.com/danielsinewe/AgentEstimate#quick-start" target="_blank" rel="noreferrer">
              Open setup guide <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="install-stack">
            <article>
              <div className="install-icon"><Sparkles size={19} /></div>
              <div><span>Codex plugin</span><strong>Review once, clean ETA every prompt</strong></div>
              <Check size={18} />
            </article>
            <article>
              <div className="install-icon"><Clock3 size={19} /></div>
              <div><span>Claude Code hooks</span><strong>Actual time captured locally</strong></div>
              <Check size={18} />
            </article>
            <article>
              <div className="install-icon"><Terminal size={19} /></div>
              <div><span>MCP server</span><strong>Estimate and explain on demand</strong></div>
              <Check size={18} />
            </article>
            <article>
              <div className="install-icon"><LockKeyhole size={19} /></div>
              <div><span>Optional strict mode</span><strong>No ETA, no prompt submission</strong></div>
              <Check size={18} />
            </article>
            <button
              className="copy-command"
              type="button"
              onClick={() => void copyText('install', 'git clone https://github.com/danielsinewe/AgentEstimate.git && cd AgentEstimate && npm install && npm run build')}
            >
              <code>git clone github.com/danielsinewe/AgentEstimate</code>
              {copied === 'install' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </section>
      </main>

      <footer>
        <a className="wordmark footer-wordmark" href="#top" aria-label="Agent ETA home"><ReturnWindowMark className="wordmark-mark" /><span>agent/eta</span></a>
        <p>Time forecasts for agents. No fake countdowns.</p>
        <div>
          <a href="https://github.com/danielsinewe/AgentEstimate" target="_blank" rel="noreferrer">GitHub</a>
          <a href="#method">Method</a>
          <button className="footer-account" type="button" onClick={() => setAccountOpen(true)} aria-haspopup="dialog">Privacy & account</button>
        </div>
      </footer>

      {accountOpen && (
        <Suspense fallback={<div className="account-loading-fallback" role="status">Opening private account…</div>}>
          <CloudAccount
            open
            onClose={() => setAccountOpen(false)}
            localRuns={samples}
          />
        </Suspense>
      )}

      {actualOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setActualOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="actual-title">
            <button className="modal-close" type="button" onClick={() => setActualOpen(false)} aria-label="Close"><X size={18} /></button>
            <span className="modal-kicker">Teach your ETA</span>
            <h2 id="actual-title">How long did it take?</h2>
            <p>The prompt is never saved. Derived timing stays here unless you turned on private sync.</p>
            <form onSubmit={recordActual}>
              <label>
                <span>Actual minutes</span>
                <input autoFocus inputMode="decimal" type="number" min="0.1" step="0.1" value={actualMinutes} onChange={(event) => setActualMinutes(event.target.value)} placeholder={String(Math.round(forecast.quantiles.p50))} />
              </label>
              <button className="primary-action modal-submit" type="submit">Save & recalibrate <ArrowUpRight size={16} /></button>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check size={16} /> {toast}
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

export default App;
