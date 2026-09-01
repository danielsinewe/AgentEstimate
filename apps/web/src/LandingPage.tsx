import { formatDuration } from '@agent-eta/core';
import { ArrowDown, ArrowUpRight, LockKeyhole, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ReturnWindowMark } from './Brand';
import { coverageAssessment } from './coverage';
import {
  bootstrapOAuthCallback,
  getPublicDashboardSnapshot,
  subscribeToPublicDashboard,
  type PublicDashboardSnapshot,
} from './lib/supabase';
import './landing.css';

function taskLabel(taskClass: string): string {
  return taskClass.replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function providerLabel(provider: string): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

export default function LandingPage() {
  const [snapshot, setSnapshot] = useState<PublicDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const callback = bootstrapOAuthCallback();
    if (callback) {
      void callback.then((result) => {
        if (result?.ok) window.location.replace('/overview');
        else if (result) setError(result.message);
      });
    }

    let active = true;
    const refreshSnapshot = async (showLoading = false) => {
      if (showLoading) setLoading(true);
      const result = await getPublicDashboardSnapshot();
      if (!active) return;
      if (result.ok) {
        setSnapshot(result.data);
        setError(null);
      } else setError(result.message);
      setLoading(false);
    };

    void refreshSnapshot(true);
    const unsubscribe = subscribeToPublicDashboard(() => void refreshSnapshot());
    const interval = window.setInterval(() => void refreshSnapshot(), 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshSnapshot();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      active = false;
      unsubscribe?.();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const maxTaskRuns = useMemo(
    () => Math.max(1, ...(snapshot?.task_breakdown.map((task) => task.totalRuns) ?? [1])),
    [snapshot],
  );
  const coverage = snapshot ? Math.round(snapshot.p80_coverage * 100) : 0;
  const coverageLabel = coverageAssessment(coverage);

  return (
    <div className="public-dashboard-shell">
      <a className="skip-link" href="#dashboard">Skip to dashboard</a>

      <header className="public-header">
        <a className="public-wordmark" href="/" aria-label="Agent ETA home">
          <ReturnWindowMark className="public-wordmark-mark" />
          <span>agent/eta</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#dashboard">Dashboard</a>
          <a href="/overview"><LockKeyhole size={13} aria-hidden="true" /> My runs</a>
          <a href="https://github.com/danielsinewe/AgentEstimate" target="_blank" rel="noreferrer">
            <ArrowUpRight size={14} aria-hidden="true" /> Source
          </a>
        </nav>
      </header>

      <main>
        <section className="public-hero" aria-labelledby="public-title">
          <div className="public-hero-copy">
            <p className="public-kicker"><span /> Public agent timing data</p>
            <h1 id="public-title">The clock,<br /><em>after</em> the promise.</h1>
            <p className="public-deck">Original ETA versus actual finish time, measured across real coding-agent runs.</p>
          </div>

          <div className="public-hero-signal" aria-hidden="true">
            <ReturnWindowMark />
            <span className="signal-caption signal-caption-a">estimate</span>
            <span className="signal-caption signal-caption-b">finish</span>
          </div>

          <a className="public-scroll" href="#dashboard">
            See the numbers <span><ArrowDown size={14} /></span>
          </a>
        </section>

        <section className="public-dashboard" id="dashboard" aria-labelledby="dashboard-title">
          <div className="public-section-heading">
            <div>
              <p className="public-eyebrow">Live snapshot</p>
              <h2 id="dashboard-title">What actually happened.</h2>
            </div>
            {snapshot && <p>Updated {dateLabel(snapshot.generated_at)}</p>}
          </div>

          {loading ? (
            <div className="public-state" role="status"><RefreshCw size={18} /> Loading public data…</div>
          ) : error && !snapshot ? (
            <div className="public-state public-state-error" role="alert">Public data is temporarily unavailable.</div>
          ) : !snapshot ? (
            <div className="public-state" role="status">The first public snapshot is being prepared.</div>
          ) : (
            <>
              <div className="public-scoreboard">
                <article className="coverage-card">
                  <span className="card-index">01 / RANGE</span>
                  <strong>{coverage}<sup>%</sup></strong>
                  <p>planning range coverage · {coverageLabel}</p>
                  <div className="coverage-track" aria-label={`${snapshot.within_p80_runs} of ${snapshot.measured_runs} measured successful runs within P80`}>
                    <span style={{ width: `${coverage}%` }} />
                  </div>
                  <small>{snapshot.within_p80_runs} of {snapshot.measured_runs} · target about 80%</small>
                </article>

                <div className="metric-grid">
                  <article>
                    <span>Total runs</span>
                    <strong>{snapshot.total_runs}</strong>
                    <small>{snapshot.successful_runs} completed</small>
                  </article>
                  <article>
                    <span>Median finish</span>
                    <strong>{formatDuration(snapshot.median_actual_minutes)}</strong>
                    <small>successful runs</small>
                  </article>
                  <article>
                    <span>Median error</span>
                    <strong>{formatDuration(snapshot.median_absolute_error_minutes)}</strong>
                    <small>from the original ETA</small>
                  </article>
                  <article>
                    <span>Stopped</span>
                    <strong>{snapshot.stopped_runs}</strong>
                    <small>kept in the dataset</small>
                  </article>
                </div>
              </div>

              <div className="public-breakdowns">
                <article className="task-breakdown">
                  <div className="breakdown-heading">
                    <span className="card-index">02 / WORK</span>
                    <h3>Runs by task</h3>
                  </div>
                  <div className="task-bars">
                    {snapshot.task_breakdown.map((task) => (
                      <div className="task-row" key={task.taskClass}>
                        <span>{taskLabel(task.taskClass)}</span>
                        <div><i style={{ width: `${(task.totalRuns / maxTaskRuns) * 100}%` }} /></div>
                        <strong>{task.totalRuns}</strong>
                        <small>{task.medianActualMinutes === null ? '—' : formatDuration(task.medianActualMinutes)} median</small>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="provider-breakdown">
                  <span className="card-index">03 / AGENTS</span>
                  <h3>Measured agents</h3>
                  <ul>
                    {snapshot.provider_breakdown.map((provider) => (
                      <li key={provider.provider}>
                        <span>{providerLabel(provider.provider)}</span>
                        <strong>{provider.totalRuns}</strong>
                        <small>{provider.successfulRuns} completed</small>
                      </li>
                    ))}
                  </ul>
                </article>
              </div>

              <p className="public-data-note">
                Aggregate derived telemetry only. No prompts, code, repository names, paths, account IDs, or individual run records.
              </p>
            </>
          )}
        </section>

        <section className="public-cta" aria-labelledby="cta-title">
          <p className="public-eyebrow">The product lives in your agent</p>
          <h2 id="cta-title">Estimate. Work. Learn.</h2>
          <p>Agent ETA adds a return-time forecast to Codex and Claude Code, then learns from what happened.</p>
          <a href="https://github.com/danielsinewe/AgentEstimate" target="_blank" rel="noreferrer">
            Get the integration <ArrowUpRight size={17} />
          </a>
        </section>
      </main>

      <footer className="public-footer">
        <a className="public-wordmark" href="/" aria-label="Agent ETA home">
          <ReturnWindowMark className="public-wordmark-mark" />
          <span>agent/eta</span>
        </a>
        <p>Return-time forecasts, measured.</p>
        <div><a href="/overview">Private history</a><a href="https://github.com/danielsinewe/AgentEstimate" target="_blank" rel="noreferrer">GitHub ↗</a></div>
      </footer>
    </div>
  );
}
