export interface PortfolioPosition {
  id: string;
  user_id: string;
  ticker: string;
  shares: number;
  watch: boolean;
  last_price: number | null;
  last_price_ts: string | null;
  last_price_source: string | null;
  alert_threshold_pct: number;
  last_alert_at: string | null;
  last_alert_price: number | null;
  last_alert_move_pct: number | null;
  created_at: string;
  updated_at: string;
  notes: string | null;
}
