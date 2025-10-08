import type { SupabaseClient } from '@supabase/supabase-js';

export interface MockDatabase {
  app_meta: Array<{ key: string; value: any; updated_at: string }>;
  reddit_posts: Array<{
    post_id: string;
    title: string;
    body: string;
    subreddit: string;
    author: string;
    url: string;
    created_utc: string;
    score: number;
    detected_tickers: string[];
    llm_tickers: string[];
    is_future_upside_claim: boolean | null;
    stance: string | null;
    reason: string | null;
    quality_score: number | null;
    emailed_at: string | null;
    processed_at: string;
  }>;
  price_watches: Array<{
    id: number;
    post_id: string;
    ticker: string;
    quality_score: number;
    entry_price: number;
    entry_price_ts: string;
    emailed_at: string;
    monitor_start_at: string;
    monitor_close_at: string;
    next_check_at: string;
    last_price: number;
    last_price_ts: string;
    status?: string;
    alert_sent_at?: string | null;
    final_price?: number | null;
    final_price_ts?: string | null;
    return_pct?: number | null;
  }>;
  post_performance: Array<{
    post_id: string;
    ticker: string;
    return_pct: number | null;
    profit_usd: number | null;
    entry_price: number | null;
    exit_price: number | null;
    lookback_date: string | null;
    run_date: string | null;
    emailed_at: string | null;
    subreddit: string | null;
    author: string | null;
    created_at: string;
  }>;
  ticker_performance: Array<{
    ticker: string;
    sample_size: number;
    sum_return_pct: number;
    win_count: number;
    avg_return_pct: number;
    win_rate_pct: number;
    last_run_date: string | null;
    updated_at: string;
  }>;
}

export class MockSupabaseClient {
  private db: MockDatabase;

  constructor(initialData?: Partial<MockDatabase>) {
    this.db = {
      app_meta: [],
      reddit_posts: [],
      price_watches: [],
      post_performance: [],
      ticker_performance: [],
      ...initialData,
    };
  }

  // Helper method to get database state for testing
  getDatabase(): MockDatabase {
    return this.db;
  }

  // Helper method to reset database
  resetDatabase(newData?: Partial<MockDatabase>): void {
    this.db = {
      app_meta: [],
      reddit_posts: [],
      price_watches: [],
      post_performance: [],
      ticker_performance: [],
      ...newData,
    };
  }

  from(table: string) {
    return {
      select: (columns: string = '*') => {
        // Extract join information from columns like "reddit_posts ( title, url )"
        const joinMatch = columns.match(/(\w+)\s*\(([^)]+)\)/);
        const joinInfo = joinMatch ? {
          table: joinMatch[1],
          columns: joinMatch[2].split(',').map(c => c.trim()),
        } : undefined;
        
        return this.buildQuery(table, 'select', columns, undefined, undefined, joinInfo);
      },
      insert: (rows: any[]) => this.buildQuery(table, 'insert', undefined, rows),
      upsert: (rows: any, options?: any) => this.buildQuery(table, 'upsert', undefined, rows, options),
      update: (data: any) => this.buildQuery(table, 'update', undefined, data),
      delete: () => this.buildQuery(table, 'delete'),
    };
  }

  private buildQuery(
    table: string,
    operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete',
    columns?: string,
    data?: any,
    options?: any,
    joinInfo?: { table: string; columns: string[] },
  ) {
    const filters: Array<{ type: string; column?: string; value?: any }> = [];
    let orderBy: { column: string; ascending: boolean } | undefined;
    let limitValue: number | undefined;
    let singleRow = false;

    const query = {
      eq: (column: string, value: any) => {
        filters.push({ type: 'eq', column, value });
        return query;
      },
      is: (column: string, value: any) => {
        filters.push({ type: 'is', column, value });
        return query;
      },
      gte: (column: string, value: any) => {
        filters.push({ type: 'gte', column, value });
        return query;
      },
      lte: (column: string, value: any) => {
        filters.push({ type: 'lte', column, value });
        return query;
      },
      in: (column: string, values: any[]) => {
        filters.push({ type: 'in', column, value: values });
        return query;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderBy = { column, ascending: opts?.ascending ?? true };
        return query;
      },
      limit: (count: number) => {
        limitValue = count;
        return query;
      },
      single: () => {
        singleRow = true;
        return query;
      },
      then: (resolve: any, reject?: any) => {
        return Promise.resolve()
          .then(async () => {
            try {
              const result = await this.executeQuery(
                table,
                operation,
                filters,
                data,
                columns,
                orderBy,
                limitValue,
                singleRow,
                options,
                joinInfo,
              );
              return result;
            } catch (error) {
              return { data: null, error };
            }
          })
          .then(resolve, reject);
      },
    };

    return query;
  }

  private async executeQuery(
    table: string,
    operation: string,
    filters: Array<{ type: string; column?: string; value?: any }>,
    data?: any,
    columns?: string,
    orderBy?: { column: string; ascending: boolean },
    limitValue?: number,
    singleRow?: boolean,
    options?: any,
    joinInfo?: { table: string; columns: string[] },
  ): Promise<{ data: any; error: any }> {
    const tableData = (this.db as any)[table];

    if (!tableData) {
      return {
        data: null,
        error: new Error(`Table ${table} not found`),
      };
    }

    try {
      switch (operation) {
        case 'select': {
          let results = [...tableData];

          // Apply filters
          for (const filter of filters) {
            results = results.filter(row => {
              switch (filter.type) {
                case 'eq':
                  return row[filter.column!] === filter.value;
                case 'is':
                  return filter.value === null
                    ? (row[filter.column!] === null || row[filter.column!] === undefined)
                    : row[filter.column!] === filter.value;
                case 'gte':
                  return row[filter.column!] >= filter.value;
                case 'lte':
                  return row[filter.column!] <= filter.value;
                case 'in':
                  return filter.value.includes(row[filter.column!]);
                default:
                  return true;
              }
            });
          }

          // Apply ordering
          if (orderBy) {
            results.sort((a, b) => {
              const aVal = a[orderBy!.column];
              const bVal = b[orderBy!.column];
              const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
              return orderBy!.ascending ? comparison : -comparison;
            });
          }

          // Apply limit
          if (limitValue !== undefined) {
            results = results.slice(0, limitValue);
          }

          // Handle joins if present
          if (joinInfo) {
            const joinedTableData = (this.db as any)[joinInfo.table] || [];
            results = results.map(row => {
              // Find matching row in joined table based on foreign key
              // Assume the foreign key is the singular form of the joined table name + _id
              // or just use post_id as the common pattern
              const foreignKey = 'post_id'; // Common in this app
              const joinedRow = joinedTableData.find((jr: any) => jr.post_id === row[foreignKey]);
              
              if (joinedRow) {
                // Only include requested columns from the joined table
                const joinedData: any = {};
                joinInfo.columns.forEach(col => {
                  if (joinedRow[col] !== undefined) {
                    joinedData[col] = joinedRow[col];
                  }
                });
                return {
                  ...row,
                  [joinInfo.table]: joinedData,
                };
              }
              
              return row;
            });
          }

          // Return single row if requested
          if (singleRow) {
            if (results.length === 0) {
              return {
                data: null,
                error: { code: 'PGRST116', message: 'No rows returned' },
              };
            }
            return { data: results[0], error: null };
          }

          return { data: results, error: null };
        }

        case 'insert': {
          const rows = Array.isArray(data) ? data : [data];
          tableData.push(...rows);
          return { data: rows, error: null };
        }

        case 'upsert': {
          const rows = Array.isArray(data) ? data : [data];
          const conflictSpec = options?.onConflict || 'id';
          const conflictColumns = (conflictSpec as string).split(',').map((col: string) => col.trim());

          for (const row of rows) {
            const existingIndex = tableData.findIndex((existing: any) => {
              // Check if all conflict columns match
              return conflictColumns.every(col => existing[col] === row[col]);
            });

            if (existingIndex >= 0) {
              tableData[existingIndex] = { ...tableData[existingIndex], ...row };
            } else {
              tableData.push(row);
            }
          }

          return { data: rows, error: null };
        }

        case 'update': {
          let updatedCount = 0;

          for (let i = 0; i < tableData.length; i++) {
            const row = tableData[i];
            let matches = true;

            // Check if row matches all filters
            for (const filter of filters) {
              switch (filter.type) {
                case 'eq':
                  if (row[filter.column!] !== filter.value) matches = false;
                  break;
                case 'in':
                  if (!filter.value.includes(row[filter.column!])) matches = false;
                  break;
              }
            }

            if (matches) {
              tableData[i] = { ...row, ...data };
              updatedCount++;
            }
          }

          return { data: { count: updatedCount }, error: null };
        }

        case 'delete': {
          let deletedCount = 0;

          for (let i = tableData.length - 1; i >= 0; i--) {
            const row = tableData[i];
            let matches = true;

            // Check if row matches all filters
            for (const filter of filters) {
              switch (filter.type) {
                case 'eq':
                  if (row[filter.column!] !== filter.value) matches = false;
                  break;
                case 'lte':
                  if (!(row[filter.column!] <= filter.value)) matches = false;
                  break;
              }
            }

            if (matches) {
              tableData.splice(i, 1);
              deletedCount++;
            }
          }

          return { data: { count: deletedCount }, error: null };
        }

        default:
          return {
            data: null,
            error: new Error(`Unsupported operation: ${operation}`),
          };
      }
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error : new Error('Unknown error'),
      };
    }
  }
}

// Factory function to create a mock SupabaseClient that matches the real interface
export function createMockSupabaseClient(
  initialData?: Partial<MockDatabase>,
): SupabaseClient {
  const mock = new MockSupabaseClient(initialData);
  return mock as unknown as SupabaseClient;
}

