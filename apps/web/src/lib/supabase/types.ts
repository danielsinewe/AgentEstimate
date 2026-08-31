export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type RunProvider = 'codex' | 'claude';
export type RunEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RunSpeed = 'standard' | 'fast';
export type RunTaskClass =
  | 'question'
  | 'research'
  | 'review'
  | 'diagnose'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'migration';
export type RunScope = 'micro' | 'small' | 'medium' | 'large' | 'project';
export type RunAmbiguity = 'low' | 'medium' | 'high';
export type RunOutcome = 'started' | 'success' | 'failed' | 'censored';
export type RunSource = 'web' | 'plugin' | 'import';
export type MetricDimension = 'overall' | 'provider' | 'provider_model' | 'provider_model_task';

export interface PublicProviderBreakdown {
  provider: RunProvider;
  totalRuns: number;
  successfulRuns: number;
}

export interface PublicTaskBreakdown {
  taskClass: RunTaskClass;
  totalRuns: number;
  successfulRuns: number;
  medianActualMinutes: number | null;
}

export interface Database {
  __InternalSupabase: {
    PostgrestVersion: '14.5';
  };
  project_agent_eta_v2: {
    Tables: {
      private_runs: {
        Row: {
          id: string;
          user_id: string;
          client_run_id: string;
          schema_version: number;
          source: RunSource;
          provider: RunProvider;
          model: string;
          effort: RunEffort;
          speed: RunSpeed;
          task_class: RunTaskClass;
          scope: RunScope | null;
          ambiguity: RunAmbiguity | null;
          included_tests: boolean;
          included_browser: boolean;
          included_external_services: boolean;
          included_deploy: boolean;
          destructive: boolean;
          forecast_p25_minutes: number | null;
          forecast_p50_minutes: number;
          forecast_p80_minutes: number | null;
          forecast_p95_minutes: number | null;
          actual_minutes: number | null;
          outcome: RunOutcome;
          client_created_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          client_run_id: string;
          schema_version?: number;
          source?: RunSource;
          provider: RunProvider;
          model: string;
          effort: RunEffort;
          speed: RunSpeed;
          task_class: RunTaskClass;
          scope?: RunScope | null;
          ambiguity?: RunAmbiguity | null;
          included_tests?: boolean;
          included_browser?: boolean;
          included_external_services?: boolean;
          included_deploy?: boolean;
          destructive?: boolean;
          forecast_p25_minutes?: number | null;
          forecast_p50_minutes: number;
          forecast_p80_minutes?: number | null;
          forecast_p95_minutes?: number | null;
          actual_minutes?: number | null;
          outcome?: RunOutcome;
          client_created_at: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          client_run_id?: string;
          schema_version?: number;
          source?: RunSource;
          provider?: RunProvider;
          model?: string;
          effort?: RunEffort;
          speed?: RunSpeed;
          task_class?: RunTaskClass;
          scope?: RunScope | null;
          ambiguity?: RunAmbiguity | null;
          included_tests?: boolean;
          included_browser?: boolean;
          included_external_services?: boolean;
          included_deploy?: boolean;
          destructive?: boolean;
          forecast_p25_minutes?: number | null;
          forecast_p50_minutes?: number;
          forecast_p80_minutes?: number | null;
          forecast_p95_minutes?: number | null;
          actual_minutes?: number | null;
          outcome?: RunOutcome;
          client_created_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'private_runs_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      user_sync_settings: {
        Row: {
          user_id: string;
          cloud_sync_enabled: boolean;
          benchmark_contribution_enabled: boolean;
          benchmark_consent_version: string | null;
          benchmark_consented_at: string | null;
          local_history_imported_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id?: string;
          cloud_sync_enabled?: boolean;
          benchmark_contribution_enabled?: boolean;
          benchmark_consent_version?: string | null;
          benchmark_consented_at?: string | null;
          local_history_imported_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          cloud_sync_enabled?: boolean;
          benchmark_contribution_enabled?: boolean;
          benchmark_consent_version?: string | null;
          benchmark_consented_at?: string | null;
          local_history_imported_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_sync_settings_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      benchmark_contributions: {
        Row: {
          id: string;
          user_id: string;
          private_run_id: string;
          provider: RunProvider;
          model: string;
          effort: RunEffort;
          speed: RunSpeed;
          task_class: RunTaskClass;
          forecast_p50_minutes: number;
          forecast_p80_minutes: number;
          forecast_p95_minutes: number | null;
          actual_minutes: number;
          consent_version: string;
          consented_at: string;
          run_created_at: string;
          contributed_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          private_run_id: string;
          provider: RunProvider;
          model: string;
          effort: RunEffort;
          speed: RunSpeed;
          task_class: RunTaskClass;
          forecast_p50_minutes: number;
          forecast_p80_minutes: number;
          forecast_p95_minutes?: number | null;
          actual_minutes: number;
          consent_version: string;
          consented_at: string;
          run_created_at: string;
          contributed_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          private_run_id?: string;
          provider?: RunProvider;
          model?: string;
          effort?: RunEffort;
          speed?: RunSpeed;
          task_class?: RunTaskClass;
          forecast_p50_minutes?: number;
          forecast_p80_minutes?: number;
          forecast_p95_minutes?: number | null;
          actual_minutes?: number;
          consent_version?: string;
          consented_at?: string;
          run_created_at?: string;
          contributed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'benchmark_contributions_private_run_id_fkey';
            columns: ['private_run_id'];
            isOneToOne: true;
            referencedRelation: 'private_runs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'benchmark_contributions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      public_metric_snapshots: {
        Row: {
          id: string;
          snapshot_key: string;
          dimension_kind: MetricDimension;
          provider: RunProvider | null;
          model: string | null;
          task_class: RunTaskClass | null;
          period_start: string;
          period_end: string;
          sample_count: number;
          contributor_count: number;
          median_actual_minutes: number;
          median_absolute_error_minutes: number;
          p50_observed_coverage: number;
          p80_observed_coverage: number;
          generated_at: string;
        };
        Insert: {
          id?: string;
          snapshot_key: string;
          dimension_kind: MetricDimension;
          provider?: RunProvider | null;
          model?: string | null;
          task_class?: RunTaskClass | null;
          period_start: string;
          period_end: string;
          sample_count: number;
          contributor_count: number;
          median_actual_minutes: number;
          median_absolute_error_minutes: number;
          p50_observed_coverage: number;
          p80_observed_coverage: number;
          generated_at?: string;
        };
        Update: {
          id?: string;
          snapshot_key?: string;
          dimension_kind?: MetricDimension;
          provider?: RunProvider | null;
          model?: string | null;
          task_class?: RunTaskClass | null;
          period_start?: string;
          period_end?: string;
          sample_count?: number;
          contributor_count?: number;
          median_actual_minutes?: number;
          median_absolute_error_minutes?: number;
          p50_observed_coverage?: number;
          p80_observed_coverage?: number;
          generated_at?: string;
        };
        Relationships: [];
      };
      public_dashboard_snapshots: {
        Row: {
          snapshot_key: string;
          total_runs: number;
          successful_runs: number;
          stopped_runs: number;
          failed_runs: number;
          measured_runs: number;
          within_p80_runs: number;
          p80_coverage: number;
          median_actual_minutes: number;
          median_absolute_error_minutes: number;
          provider_breakdown: Json;
          task_breakdown: Json;
          period_start: string;
          period_end: string;
          generated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      contribute_private_run: {
        Args: { p_private_run_id: string; p_consent_version: string };
        Returns: string;
      };
      delete_agent_eta_data: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      refresh_agent_eta_public_metrics: {
        Args: { p_period_start?: string; p_period_end?: string };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type PrivateRunRow = Database['project_agent_eta_v2']['Tables']['private_runs']['Row'];
export type PrivateRunInsert = Database['project_agent_eta_v2']['Tables']['private_runs']['Insert'];
export type SyncSettingsRow = Database['project_agent_eta_v2']['Tables']['user_sync_settings']['Row'];
export type ContributionRow = Database['project_agent_eta_v2']['Tables']['benchmark_contributions']['Row'];
export type PublicMetricSnapshot = Database['project_agent_eta_v2']['Tables']['public_metric_snapshots']['Row'];
export type PublicDashboardSnapshotRow = Database['project_agent_eta_v2']['Tables']['public_dashboard_snapshots']['Row'];

export type PublicDashboardSnapshot = Omit<
  PublicDashboardSnapshotRow,
  'provider_breakdown' | 'task_breakdown'
> & {
  provider_breakdown: PublicProviderBreakdown[];
  task_breakdown: PublicTaskBreakdown[];
};
