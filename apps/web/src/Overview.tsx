import type { User } from '@supabase/supabase-js';
import { formatDuration } from '@agent-eta/core';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  Cloud,
  Gauge,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReturnWindowMark } from './Brand';
import {
  getAuthenticatedUser,
  listPrivateRuns,
  subscribeToAuth,
  type PrivateRunRow,
} from './lib/supabase';
import {
  loadLocalHistory,
  mergeLocalHistory,
  saveLocalHistory,
  type WebCalibrationSample,
} from './localHistory';
import { parsePluginHistory } from './pluginHistory';

const CloudAccount = lazy(() => import('./CloudAccount'));
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

interface DisplayRun {
  id: string;
  provider: string;
  model: string;
  taskClass: string;
  p50: number;
  p80: number | null;
  actual: number | null;
  outcome: string;
  createdAt: string;
  source: string;
}

function taskLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function userLabel(user: User | null): string {
  if (!user) return 'Account';
  const name = user.user_metadata?.user_name ?? user.user_metadata?.preferred_username;
  return typeof name === 'string' && name.trim() ? name : 'Account';
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function fromLocal(run: WebCalibrationSample): DisplayRun {
  return {
    id: run.id,
    provider: run.provider,
    model: run.model,
    taskClass: run.taskClass,
    p50: run.estimatedMinutes,
    p80: run.estimatedP80Minutes ?? null,
    actual: run.actualMinutes,
    outcome: run.outcome ?? (run.successful ? 'success' : 'failed'),
    createdAt: run.createdAt,
    source: run.historySource ?? 'web',
  };
}

function fromCloud(run: PrivateRunRow): DisplayRun {
  return {
    id: run.client_run_id,
    provider: run.provider,
    model: run.model,
    taskClass: run.task_class,
    p50: run.forecast_p50_minutes,
    p80: run.forecast_p80_minutes,
    actual: run.actual_minutes,
    outcome: run.outcome,
    createdAt: run.client_created_at,
    source: run.source,
  };
}

function runStatus(run: DisplayRun): { label: string; tone: string } {
  if (run.outcome === 'started') return { label: 'Running', tone: 'active' };
  if (run.outcome === 'failed') return { label: 'Failed', tone: 'failed' };
  if (run.outcome === 'censored') return { label: 'Stopped', tone: 'muted' };
  if (run.actual !== null && run.p80 !== null && run.actual <= run.p80) {
    return { label: 'Within range', tone: 'good' };
  }
  return { label: 'Ran over', tone: 'over' };
}

export default function OverviewPage() {
  const [localRuns, setLocalRuns] = useState<WebCalibrationSample[]>(loadLocalHistory);
  const [cloudRuns, setCloudRuns] = useState<PrivateRunRow[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [loadingCloud, setLoadingCloud] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const refreshCloud = useCallback(async () => {
    setLoadingCloud(true);
    const result = await listPrivateRuns();
    setCloudRuns(result.ok ? result.data : []);
    setLoadingCloud(false);
  }, []);

  useEffect(() => {
    let active = true;
    void getAuthenticatedUser().then((result) => {
      if (!active) return;
      const nextUser = result.ok ? result.data : null;
      setUser(nextUser);
      if (nextUser) void refreshCloud();
      else setLoadingCloud(false);
    });
    const subscription = subscribeToAuth((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      if (session?.user) void refreshCloud();
      else {
        setCloudRuns([]);
        setLoadingCloud(false);
      }
    });
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [refreshCloud]);

  const runs = useMemo(() => {
    const combined = new Map(localRuns.map((run) => [run.id, fromLocal(run)]));
    for (const run of cloudRuns) combined.set(run.client_run_id, fromCloud(run));
    return [...combined.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [cloudRuns, localRuns]);

  const completed = runs.filter((run) => run.actual !== null && run.outcome === 'success');
  const measured = completed.filter((run) => run.p80 !== null);
  const withinRange = measured.filter((run) => (run.actual ?? Number.POSITIVE_INFINITY) <= (run.p80 ?? 0));
  const coverage = measured.length ? Math.round((withinRange.length / measured.length) * 100) : null;
  const medianError = median(completed.map((run) => Math.abs((run.actual ?? 0) - run.p50)));

  async function importPluginHistory(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setNotice('That history file is too large. Choose a file under 10 MB.');
      return;
    }
    const parsed = parsePluginHistory(await file.text());
    if (!parsed.runs.length) {
      setNotice('No completed Agent ETA runs were found in that file.');
      return;
    }
    const merged = mergeLocalHistory(localRuns, parsed.runs);
    setLocalRuns(merged);
    saveLocalHistory(merged);
    const ignored = parsed.incompleteRuns + parsed.ignoredLines;
    setNotice(`Imported ${parsed.runs.length} completed run${parsed.runs.length === 1 ? '' : 's'}${ignored ? ` · skipped ${ignored} unfinished or invalid` : ''}.`);
    if (importInput.current) importInput.current.value = '';
  }

  return (
    <div className="overview-shell">
      <a className="skip-link" href="#run-history">Skip to run history</a>
      <header className="site-header overview-header">
        <a className="wordmark" href="/" aria-label="Agent ETA home">
          <ReturnWindowMark className="wordmark-mark" />
          <span>agent/eta</span>
        </a>
        <nav aria-label="Overview navigation">
          <a href="/">Public dashboard</a>
          <button className="nav-account" type="button" onClick={() => setAccountOpen(true)}>
            <LockKeyhole size={14} aria-hidden="true" /> {userLabel(user)}
          </button>
        </nav>
      </header>

      <main className="overview-main">
        <section className="overview-title" aria-labelledby="overview-title">
          <div>
            <span className="overview-kicker">Your Agent ETA</span>
            <h1 id="overview-title">Your runs.<br /><em>Measured.</em></h1>
          </div>
          <div className="overview-actions">
            <input
              ref={importInput}
              className="visually-hidden"
              type="file"
              accept=".jsonl,application/x-ndjson,application/json,text/plain"
              onChange={(event) => void importPluginHistory(event.target.files?.[0])}
            />
            <button className="overview-import" type="button" onClick={() => importInput.current?.click()}>
              <ArrowDownToLine size={16} /> Import plugin history
            </button>
            <a className="overview-new" href="/">Public dashboard <ArrowRight size={16} /></a>
          </div>
        </section>

        {notice && <div className="overview-notice" role="status"><Check size={15} /> {notice}</div>}

        <section className="overview-metrics" aria-label="Run summary">
          <article className="overview-primary-metric">
            <span>Within planning range</span>
            <strong>{coverage === null ? '—' : `${coverage}%`}</strong>
            <p>{measured.length ? `${withinRange.length} of ${measured.length} completed runs` : 'Import completed runs to measure accuracy.'}</p>
            <div className="overview-meter" aria-hidden="true"><i style={{ width: `${coverage ?? 0}%` }} /></div>
          </article>
          <article>
            <span>Total runs</span>
            <strong>{runs.length}</strong>
            <p>{completed.length} completed</p>
            <Clock3 size={20} aria-hidden="true" />
          </article>
          <article>
            <span>Median error</span>
            <strong>{medianError === null ? '—' : formatDuration(medianError)}</strong>
            <p>Against the original ETA</p>
            <Gauge size={20} aria-hidden="true" />
          </article>
          <article>
            <span>History</span>
            <strong>{cloudRuns.length ? 'Synced' : 'Local'}</strong>
            <p>{cloudRuns.length ? `${cloudRuns.length} private cloud runs` : 'Private on this browser'}</p>
            {loadingCloud ? <RefreshCw className="overview-spin" size={20} aria-hidden="true" /> : <Cloud size={20} aria-hidden="true" />}
          </article>
        </section>

        <section className="overview-history" id="run-history" aria-labelledby="history-title">
          <div className="overview-section-heading">
            <div>
              <span className="section-number">01</span>
              <h2 id="history-title">Recent runs</h2>
            </div>
            <span>{runs.length} total</span>
          </div>

          {runs.length ? (
            <div className="run-table" role="table" aria-label="Agent ETA run history">
              <div className="run-table-head" role="row">
                <span role="columnheader">Task</span>
                <span role="columnheader">Original ETA</span>
                <span role="columnheader">Actual</span>
                <span role="columnheader">Result</span>
              </div>
              {runs.slice(0, 50).map((run) => {
                const status = runStatus(run);
                return (
                  <article className="run-row" role="row" key={run.id}>
                    <div className="run-task" role="cell">
                      <span className={`provider-mark provider-${run.provider}`}>{run.provider === 'codex' ? 'C' : 'CL'}</span>
                      <div>
                        <strong>{taskLabel(run.taskClass)}</strong>
                        <small>{run.model} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.createdAt))}</small>
                      </div>
                    </div>
                    <div className="run-time" role="cell">
                      <strong>{formatDuration(run.p50)}</strong>
                      <small>{run.p80 === null ? 'No upper bound' : `allow ${formatDuration(run.p80)}`}</small>
                    </div>
                    <div className="run-time" role="cell">
                      <strong>{run.actual === null ? 'Running' : formatDuration(run.actual)}</strong>
                      <small>{run.source === 'plugin' ? 'Plugin' : run.source === 'web' ? 'Web' : taskLabel(run.source)}</small>
                    </div>
                    <div role="cell"><span className={`run-status run-status-${status.tone}`}>{status.label}</span></div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="overview-empty">
              <ReturnWindowMark />
              <h3>No runs here yet.</h3>
              <p>Import Agent ETA’s local history to see original estimates beside actual time.</p>
              <button type="button" onClick={() => importInput.current?.click()}>
                Import plugin history <ArrowRight size={15} />
              </button>
              <code>~/.codex/plugins/data/agent-eta-indiecorns/runs.jsonl</code>
            </div>
          )}
        </section>
      </main>

      <footer className="overview-footer">
        <a className="wordmark footer-wordmark" href="/"><ReturnWindowMark className="wordmark-mark" /><span>agent/eta</span></a>
        <p>Original estimate. Actual time. Better next run.</p>
        <a href="/">Public dashboard</a>
      </footer>

      {accountOpen && (
        <Suspense fallback={<div className="account-loading-fallback" role="status">Opening private account…</div>}>
          <CloudAccount
            open
            onClose={() => {
              setAccountOpen(false);
              if (user) void refreshCloud();
            }}
            localRuns={localRuns}
          />
        </Suspense>
      )}
    </div>
  );
}
