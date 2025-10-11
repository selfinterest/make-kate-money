import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import type { PortfolioPosition } from './types';

interface FormState {
  ticker: string;
  shares: string;
  watch: boolean;
}

function formatUsd(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

function SignInView({ loading }: { loading: boolean }) {
  const handleSignIn = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
  };

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>Portfolio Watch</h1>
        <p>Sign in with Google to manage your positions.</p>
        <button className="primary-button" onClick={handleSignIn} disabled={loading}>
          {loading ? 'Loading…' : 'Sign in with Google'}
        </button>
      </div>
    </main>
  );
}

function DashboardView({
  session,
  positions,
  onRefresh,
  loading,
  error,
  form,
  setForm,
}: {
  session: Session;
  positions: PortfolioPosition[];
  onRefresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
  form: FormState;
  setForm: (next: FormState) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const watchedCount = useMemo(
    () => positions.filter(position => position.watch).length,
    [positions],
  );

  const resetForm = () => {
    setForm({
      ticker: '',
      shares: '',
      watch: false,
    });
    setFormError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const ticker = form.ticker.trim().toUpperCase();
    const shares = Number.parseFloat(form.shares);

    if (!ticker || ticker.length < 1) {
      setFormError('Ticker is required.');
      return;
    }

    if (!Number.isFinite(shares) || shares < 0) {
      setFormError('Enter a valid share count (0 or greater).');
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      const { error: upsertError } = await supabase
        .from('portfolio_positions')
        .upsert(
          {
            user_id: session.user.id,
            ticker,
            shares,
            watch: form.watch,
          },
          { onConflict: 'user_id,ticker' },
        );

      if (upsertError) {
        throw upsertError;
      }

      await onRefresh();
      resetForm();
    } catch (err) {
      console.error(err);
      setFormError(err instanceof Error ? err.message : 'Failed to save position.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleWatch = async (position: PortfolioPosition) => {
    try {
      const { error: updateError } = await supabase
        .from('portfolio_positions')
        .update({ watch: !position.watch })
        .eq('id', position.id);
      if (updateError) {
        throw updateError;
      }
      await onRefresh();
    } catch (err) {
      console.error(err);
      setFormError(err instanceof Error ? err.message : 'Failed to update watch setting.');
    }
  };

  const handleDelete = async (position: PortfolioPosition) => {
    const confirmed = window.confirm(`Remove ${position.ticker} from your portfolio?`);
    if (!confirmed) return;
    try {
      const { error: deleteError } = await supabase
        .from('portfolio_positions')
        .delete()
        .eq('id', position.id);
      if (deleteError) {
        throw deleteError;
      }
      await onRefresh();
    } catch (err) {
      console.error(err);
      setFormError(err instanceof Error ? err.message : 'Failed to delete position.');
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Portfolio Watch</h1>
          <p className="subtitle">
            Signed in as <span className="accent">{session.user.email}</span>
          </p>
        </div>
        <button className="secondary-button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <section className="card">
        <h2>Add or Update Position</h2>
        <form className="position-form" onSubmit={handleSubmit}>
          <label>
            Ticker
            <input
              type="text"
              value={form.ticker}
              onChange={event => setForm({ ...form, ticker: event.target.value.toUpperCase() })}
              placeholder="AMZN"
              maxLength={12}
              required
            />
          </label>

          <label>
            Shares
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.shares}
              onChange={event => setForm({ ...form, shares: event.target.value })}
              placeholder="10"
              required
            />
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.watch}
              onChange={event => setForm({ ...form, watch: event.target.checked })}
            />
            Watch for 5% drops
          </label>

          <div className="form-actions">
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? 'Saving…' : 'Save Position'}
            </button>
            <button type="button" className="ghost-button" onClick={resetForm} disabled={saving}>
              Clear
            </button>
          </div>

          {formError && <p className="error-text">{formError}</p>}
        </form>
      </section>

      <section className="card">
        <header className="card-header">
          <div>
            <h2>Portfolio</h2>
            <p className="subtitle">
              {positions.length} positions · {watchedCount} watched
            </p>
          </div>
          <button className="ghost-button" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </header>

        {error && <p className="error-text">{error}</p>}

        <div className="grid">
          <div className="grid-header">
            <span>Ticker</span>
            <span>Shares</span>
            <span>Watch</span>
            <span>Last Price</span>
            <span>Updated</span>
            <span>Last Alert</span>
            <span>Actions</span>
          </div>
          {loading && positions.length === 0 ? (
            <p className="empty-state">Loading positions…</p>
          ) : positions.length === 0 ? (
            <p className="empty-state">No positions yet. Add one to get started.</p>
          ) : (
            positions.map(position => (
              <div
                key={position.id}
                className={`grid-row ${position.watch ? 'watched' : ''}`}
              >
                <span className="ticker-cell">{position.ticker}</span>
                <span>{position.shares}</span>
                <span>
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={position.watch}
                      onChange={() => handleToggleWatch(position)}
                    />
                    {position.watch ? 'Watching' : 'Idle'}
                  </label>
                </span>
                <span>{formatUsd(position.last_price)}</span>
                <span>{formatTime(position.last_price_ts)}</span>
                <span>
                  {position.last_alert_at
                    ? `${formatPct(position.last_alert_move_pct)} @ ${formatTime(position.last_alert_at)}`
                    : '—'}
                </span>
                <span className="actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setForm({
                        ticker: position.ticker,
                        shares: String(position.shares),
                        watch: position.watch,
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="destructive-button"
                    onClick={() => handleDelete(position)}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [formState, setFormState] = useState<FormState>({
    ticker: '',
    shares: '',
    watch: false,
  });

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session ?? null);
        setInitializing(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const fetchPositions = async () => {
    if (!session) {
      setPositions([]);
      return;
    }
    setLoadingPositions(true);
    setPositionsError(null);
    try {
      const { data, error } = await supabase
        .from('portfolio_positions')
        .select('*')
        .order('ticker', { ascending: true });
      if (error) {
        throw error;
      }
      setPositions(
        (data ?? []).map(item => ({
          ...item,
          shares: Number(item.shares),
          last_price: item.last_price !== null ? Number(item.last_price) : null,
          alert_threshold_pct: Number(item.alert_threshold_pct ?? 0.05),
          last_alert_price: item.last_alert_price !== null ? Number(item.last_alert_price) : null,
          last_alert_move_pct: item.last_alert_move_pct !== null ? Number(item.last_alert_move_pct) : null,
        })) as PortfolioPosition[],
      );
    } catch (err) {
      console.error(err);
      setPositionsError(err instanceof Error ? err.message : 'Failed to load positions.');
    } finally {
      setLoadingPositions(false);
    }
  };

  useEffect(() => {
    if (session) {
      fetchPositions();
    } else {
      setPositions([]);
    }
  }, [session]);

  if (!session) {
    return <SignInView loading={initializing} />;
    }

  return (
    <DashboardView
      session={session}
      positions={positions}
      onRefresh={fetchPositions}
      loading={loadingPositions}
      error={positionsError}
      form={formState}
      setForm={setFormState}
    />
  );
}
