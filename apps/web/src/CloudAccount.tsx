import type { User } from '@supabase/supabase-js';
import { formatDuration } from '@agent-eta/core';
import {
  Check,
  Cloud,
  Download,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  BENCHMARK_CONSENT_VERSION,
  LOCAL_HISTORY_IMPORT_DECISION,
  deleteAllPrivateRuns,
  deleteAccount as deleteCloudAccount,
  deletePrivateRun,
  getAuthenticatedUser,
  getSyncSettings,
  importLocalHistory,
  isCloudDataConfigured,
  listPrivateRuns,
  setBenchmarkContributionEnabled,
  setCloudSyncEnabled,
  signInWithGitHub,
  signOut,
  subscribeToAuth,
  type CloudResult,
  type LocalRunInput,
  type PrivateRunRow,
  type SyncSettings,
} from './lib/supabase';

const DEFAULT_SETTINGS: SyncSettings = {
  cloudSyncEnabled: false,
  benchmarkContributionEnabled: false,
  benchmarkConsentVersion: null,
  benchmarkConsentedAt: null,
  localHistoryImportedAt: null,
};

export type DeleteCloudAccount = () => Promise<CloudResult<{ deleted: true }>>;

export interface CloudAccountProps {
  open: boolean;
  onClose: () => void;
  localRuns: readonly LocalRunInput[];
  /** Authenticated deletion helper, normally backed by a server-side function. */
  deleteAccount?: DeleteCloudAccount;
}

function accountLabel(user: User): string {
  const metadataName = user.user_metadata?.user_name ?? user.user_metadata?.preferred_username;
  if (typeof metadataName === 'string' && metadataName.trim()) return metadataName;
  return user.email || 'GitHub account';
}

function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.04 1.77 2.71 1.26 3.37.96.1-.75.41-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.75 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.41-2.71 5.4-5.29 5.68.42.36.79 1.08.79 2.19v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function runDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(timestamp));
}

function exportableRun(run: PrivateRunRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'user_id'));
}

export function CloudAccount({ open, onClose, localRuns, deleteAccount }: CloudAccountProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<SyncSettings>(DEFAULT_SETTINGS);
  const [cloudRuns, setCloudRuns] = useState<PrivateRunRow[]>([]);
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const configured = isCloudDataConfigured();

  const completedRuns = useMemo(
    () => cloudRuns.filter((run) => run.actual_minutes !== null),
    [cloudRuns],
  );

  const refreshCloud = useCallback(async () => {
    setBusy('refresh');
    setError(null);
    const [settingsResult, runsResult] = await Promise.all([
      getSyncSettings(),
      listPrivateRuns(),
    ]);

    if (settingsResult.ok) setSettings(settingsResult.data);
    if (runsResult.ok) setCloudRuns(runsResult.data);
    if (!settingsResult.ok) setError(settingsResult.message);
    else if (!runsResult.ok) setError(runsResult.message);
    setBusy(null);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) {
      setConfirmImport(false);
      setConfirmDeleteId(null);
      setConfirmDeleteAll(false);
      setConfirmDeleteAccount(false);
    }
  }, [open]);

  useEffect(() => {
    let active = true;
    void getAuthenticatedUser().then((result) => {
      if (!active) return;
      setUser(result.ok ? result.data : null);
      if (!result.ok && !['not-configured', 'signed-out'].includes(result.kind)) {
        setError(result.message);
      }
      setLoadingAccount(false);
    });

    const subscription = subscribeToAuth((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setLoadingAccount(false);
    });
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (user) void refreshCloud();
    else {
      setSettings(DEFAULT_SETTINGS);
      setCloudRuns([]);
    }
  }, [refreshCloud, user]);

  async function handleSignIn() {
    setBusy('sign-in');
    setError(null);
    const result = await signInWithGitHub();
    if (!result.ok) {
      setError(result.message);
      setBusy(null);
    }
  }

  async function handleSignOut() {
    setBusy('sign-out');
    setError(null);
    const result = await signOut();
    if (!result.ok) setError(result.message);
    else {
      setUser(null);
      setNotice('Signed out. Local history stays on this device.');
    }
    setBusy(null);
  }

  async function handleSyncChange(enabled: boolean) {
    setBusy('sync');
    setError(null);
    setNotice(null);
    const result = await setCloudSyncEnabled(enabled);
    if (!result.ok) setError(result.message);
    else {
      setSettings(result.data);
      setNotice(enabled
        ? 'Cloud sync is on for new runs. Existing browser runs were not imported.'
        : 'Cloud sync is off. Existing cloud history was kept.');
    }
    setBusy(null);
  }

  async function handleBenchmarkChange(enabled: boolean) {
    setBusy('benchmark');
    setError(null);
    setNotice(null);
    const result = await setBenchmarkContributionEnabled(enabled, BENCHMARK_CONSENT_VERSION);
    if (!result.ok) setError(result.message);
    else {
      setSettings(result.data);
      setNotice(enabled
        ? 'Benchmark contribution is on for future eligible runs.'
        : 'Benchmark contribution is off.');
    }
    setBusy(null);
  }

  async function handleImport() {
    if (!confirmImport) {
      setConfirmImport(true);
      return;
    }
    setBusy('import');
    setError(null);
    setNotice(null);
    const result = await importLocalHistory(localRuns, {
      decision: LOCAL_HISTORY_IMPORT_DECISION,
      confirmedAt: new Date().toISOString(),
    });
    if (!result.ok) setError(result.message);
    else {
      setNotice(`Imported ${result.data.imported} local run${result.data.imported === 1 ? '' : 's'}.`);
      await refreshCloud();
    }
    setConfirmImport(false);
    setBusy(null);
  }

  function handleExport() {
    const payload = {
      product: 'Agent ETA',
      exportedAt: new Date().toISOString(),
      runs: cloudRuns.map(exportableRun),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-eta-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(`Exported ${cloudRuns.length} cloud run${cloudRuns.length === 1 ? '' : 's'}.`);
  }

  async function handleDeleteRun(runId: string) {
    if (confirmDeleteId !== runId) {
      setConfirmDeleteId(runId);
      return;
    }
    setBusy(`delete-${runId}`);
    setError(null);
    const result = await deletePrivateRun(runId);
    if (!result.ok) setError(result.message);
    else {
      setCloudRuns((current) => current.filter((run) => run.id !== runId));
      setNotice('Cloud run deleted.');
    }
    setConfirmDeleteId(null);
    setBusy(null);
  }

  async function handleDeleteAll() {
    if (!confirmDeleteAll) {
      setConfirmDeleteAll(true);
      return;
    }
    setBusy('delete-all');
    setError(null);
    const result = await deleteAllPrivateRuns();
    if (!result.ok) setError(result.message);
    else {
      setCloudRuns([]);
      setNotice('All cloud history deleted. Local history was not changed.');
    }
    setConfirmDeleteAll(false);
    setBusy(null);
  }

  async function handleDeleteAccount() {
    if (!confirmDeleteAccount) {
      setConfirmDeleteAccount(true);
      return;
    }
    setBusy('delete-account');
    setError(null);
    const result = deleteAccount
      ? await deleteAccount()
      : await deleteCloudAccount(ACCOUNT_DELETION_CONFIRMATION);
    if (!result.ok) setError(result.message);
    else {
      setUser(null);
      setCloudRuns([]);
      setNotice('Account deleted. Local browser history was kept.');
    }
    setConfirmDeleteAccount(false);
    setBusy(null);
  }

  return (
    <dialog
      ref={dialogRef}
      className="cloud-account-dialog"
      aria-labelledby="cloud-account-title"
      onClose={onClose}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="cloud-account-card" aria-busy={busy !== null}>
        <header className="cloud-account-header">
          <div>
            <span className="cloud-account-kicker"><Cloud size={13} /> Optional account</span>
            <h2 id="cloud-account-title">Your Agent ETA</h2>
          </div>
          <button
            className="cloud-icon-button"
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close account dialog"
          >
            <X size={17} />
          </button>
        </header>

        {error && <p className="cloud-message cloud-message-error" role="alert">{error}</p>}
        {notice && <p className="cloud-message" role="status"><Check size={14} /> {notice}</p>}

        {loadingAccount ? (
          <div className="cloud-account-loading" role="status">
            <RefreshCw size={17} /> Checking account…
          </div>
        ) : !user ? (
          <section className="cloud-sign-in" aria-label="Sign in">
            <div className="cloud-sign-in-mark"><LockKeyhole size={22} /></div>
            <h3>Keep forecasts private</h3>
            <p>Sign in only if you want private history across devices. The estimator works without an account.</p>
            <button
              className="cloud-button cloud-button-primary"
              type="button"
              onClick={() => void handleSignIn()}
              disabled={!configured || busy !== null}
            >
              <GitHubMark /> {busy === 'sign-in' ? 'Opening GitHub…' : 'Continue with GitHub'}
            </button>
            {!configured && <small>Cloud accounts are not configured yet.</small>}
          </section>
        ) : (
          <div className="cloud-account-body">
            <section className="cloud-profile" aria-label="Signed-in account">
              <div className="cloud-avatar" aria-hidden="true">{accountLabel(user).slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{accountLabel(user)}</strong>
                {user.email && <span>{user.email}</span>}
              </div>
              <button className="cloud-text-button" type="button" onClick={() => void handleSignOut()} disabled={busy !== null}>
                <LogOut size={14} /> Sign out
              </button>
            </section>

            <section className="cloud-setting" aria-labelledby="private-sync-title">
              <div className="cloud-setting-copy">
                <h3 id="private-sync-title">Private cloud sync</h3>
                <p>New runs only. Turning this on never uploads existing browser history.</p>
              </div>
              <label className="cloud-switch">
                <span className="visually-hidden">Private cloud sync</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.cloudSyncEnabled}
                  onChange={(event) => void handleSyncChange(event.target.checked)}
                  disabled={busy !== null}
                />
                <span aria-hidden="true" />
              </label>
            </section>

            <section className="cloud-local-import" aria-labelledby="local-import-title">
              <div>
                <h3 id="local-import-title">Browser history</h3>
                <p>{localRuns.length} local run{localRuns.length === 1 ? '' : 's'} stay on this device.</p>
              </div>
              <div className="cloud-confirm-actions">
                {confirmImport && (
                  <button className="cloud-text-button" type="button" onClick={() => setConfirmImport(false)}>
                    Cancel
                  </button>
                )}
                <button
                  className="cloud-button"
                  type="button"
                  onClick={() => void handleImport()}
                  disabled={!settings.cloudSyncEnabled || localRuns.length === 0 || busy !== null}
                >
                  {confirmImport ? `Confirm import ${localRuns.length}` : `Import ${localRuns.length} local runs`}
                </button>
              </div>
            </section>

            <section className="cloud-history" aria-labelledby="cloud-history-title">
              <div className="cloud-section-heading">
                <div>
                  <h3 id="cloud-history-title">Cloud history</h3>
                  <p>{cloudRuns.length} private run{cloudRuns.length === 1 ? '' : 's'}</p>
                </div>
                <button className="cloud-text-button" type="button" onClick={handleExport} disabled={!cloudRuns.length || busy !== null}>
                  <Download size={14} /> Export JSON
                </button>
              </div>

              {cloudRuns.length ? (
                <ul className="cloud-run-list">
                  {cloudRuns.map((run) => (
                    <li key={run.id}>
                      <div>
                        <strong>{run.provider === 'codex' ? 'Codex' : 'Claude Code'} · {run.model}</strong>
                        <span>{run.task_class} · {runDate(run.client_created_at)}</span>
                      </div>
                      <span className="cloud-run-time">
                        {run.actual_minutes === null ? 'Forecast ' : 'Actual '}
                        {formatDuration(run.actual_minutes ?? run.forecast_p50_minutes)}
                      </span>
                      <div className="cloud-run-delete">
                        {confirmDeleteId === run.id && (
                          <button className="cloud-text-button" type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        )}
                        <button
                          className={confirmDeleteId === run.id ? 'cloud-text-button cloud-danger' : 'cloud-icon-button'}
                          type="button"
                          onClick={() => void handleDeleteRun(run.id)}
                          disabled={busy !== null}
                          aria-label={confirmDeleteId === run.id ? 'Confirm delete run' : 'Delete run'}
                        >
                          <Trash2 size={14} /> {confirmDeleteId === run.id && 'Delete'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cloud-empty">No cloud runs yet.</p>
              )}

              <div className="cloud-history-footer">
                <span>{completedRuns.length} completed</span>
                <div className="cloud-confirm-actions">
                  {confirmDeleteAll && (
                    <button className="cloud-text-button" type="button" onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
                  )}
                  <button
                    className="cloud-text-button cloud-danger"
                    type="button"
                    onClick={() => void handleDeleteAll()}
                    disabled={!cloudRuns.length || busy !== null}
                  >
                    <Trash2 size={14} /> {confirmDeleteAll ? 'Confirm delete all' : 'Delete all'}
                  </button>
                </div>
              </div>
            </section>

            <section className="cloud-setting cloud-benchmark" aria-labelledby="benchmark-title">
              <div className="cloud-setting-copy">
                <span className="cloud-future-label">Future, opt-in</span>
                <h3 id="benchmark-title">Contribute to benchmarks</h3>
                <p>Future eligible runs stay tied to your private account so you can retract them. Never prompts, code, or repository names.</p>
                <small>Only grouped results become public at 25+ runs from 20+ people.</small>
              </div>
              <label className="cloud-switch">
                <span className="visually-hidden">Contribute future eligible runs to benchmarks</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.benchmarkContributionEnabled}
                  onChange={(event) => void handleBenchmarkChange(event.target.checked)}
                  disabled={busy !== null}
                />
                <span aria-hidden="true" />
              </label>
            </section>

            <section className="cloud-account-danger" aria-labelledby="delete-account-title">
              <div>
                <h3 id="delete-account-title">Delete account</h3>
                <p>Deletes cloud data and contributions. Local browser history stays here.</p>
              </div>
              <div className="cloud-confirm-actions">
                {confirmDeleteAccount && (
                  <button className="cloud-text-button" type="button" onClick={() => setConfirmDeleteAccount(false)}>Cancel</button>
                )}
                <button
                  className="cloud-text-button cloud-danger"
                  type="button"
                  onClick={() => void handleDeleteAccount()}
                  disabled={busy !== null}
                >
                  {confirmDeleteAccount ? 'Confirm delete account' : 'Delete account'}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </dialog>
  );
}

export default CloudAccount;
