export interface PositionEntry {
  requested: string;
  actual?: string;
  price?: number;
}

export interface PositionExit {
  requested: string;
  actual?: string;
  price?: number;
}

export interface PositionReport {
  ticker: string;
  postId: string;
  title: string;
  author: string | null;
  url: string;
  reason: string | null;
  emailedAt: string;
  createdUtc: string;
  subreddit: string | null;
  entryAdjustment?: string;
  entry: PositionEntry;
  exit: PositionExit;
  shares?: number;
  finalValue?: number;
  profitUsd?: number;
  returnPct?: number;
  error?: string;
}

export interface ReportSummary {
  runDateEt: string;
  lookbackDateEt: string;
  generatedAt: string;
  totalPositions: number;
  completedPositions: number;
  erroredPositions: number;
  grossInvestedUsd: number;
  grossFinalValueUsd: number;
  netProfitUsd: number;
  averageReturnPct: number | null;
  winRatePct: number | null;
  bestPosition?: { ticker: string; returnPct: number; profitUsd: number; postId: string };
  worstPosition?: { ticker: string; returnPct: number; profitUsd: number; postId: string };
  tiingoRequestsUsed: number;
}

export interface ReportPayload {
  meta: ReportSummary;
  positions: PositionReport[];
}

export interface PerformanceEmailPayload {
  report: ReportSummary;
  completed: Array<{
    ticker: string;
    title: string;
    url: string;
    author: string | null;
    returnPct: number;
    profitUsd: number;
    entryPrice?: number;
    exitPrice?: number;
  }>;
  errors: Array<{
    ticker: string;
    title: string;
    url: string;
    author: string | null;
    error: string;
  }>;
  downloadUrl: string;
}
