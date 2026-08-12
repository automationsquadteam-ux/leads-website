/**
 * Database types for the Leads CRM schema.
 *
 * Hand-maintained to mirror `supabase/migrations/*.sql`. Once you have a live
 * project you can regenerate instead:
 *
 *   npm run types:gen                       # local stack
 *   supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts
 *
 * If you change a migration, change this file in the same commit.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type AppRole = 'admin' | 'viewer';

export type LeadStatus =
  | 'new'
  | 'researching'
  | 'ready'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'replied'
  | 'bounced'
  | 'invalid'
  | 'archived';

export type EmailLogStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'failed';

export type ReplySentiment = 'positive' | 'neutral' | 'negative' | 'unsubscribe' | 'auto_reply';

export type IntegrationRunStatus = 'running' | 'success' | 'failed';

/** Which message of the three-step sequence a draft belongs to. */
export type EmailType = 'initial' | 'followup1' | 'followup2';

export type EmailVersionStatus = 'draft' | 'approved' | 'rejected';

/**
 * Where a lead sits in the outreach lifecycle. Derived in Postgres by
 * public.compute_pipeline_stage() never assigned by application code.
 */
export type PipelineStage =
  | 'need_email'
  | 'dead_email'
  | 'need_verification'
  | 'research'
  | 'draft'
  | 'review'
  | 'approved'
  | 'initial_sent'
  | 'followup1_sent'
  | 'followup2_sent'
  | 'replied'
  | 'closed';

/** Derived by public.compute_next_step(). Also never assigned in TypeScript. */
export type PipelineNextStep =
  | 'need_email'
  | 'need_verification'
  | 'research_lead'
  | 'generate_draft'
  | 'approve_draft'
  | 'send_initial_email'
  | 'await_followup1'
  | 'send_followup1'
  | 'await_followup2'
  | 'send_followup2'
  | 'close_workflow'
  | 'complete';

/**
 * What an email verifier reported. A boolean cannot carry this: `accept_all`
 * means the domain accepts everything so the check proved nothing, and
 * `unknown` means the verifier gave up neither is "true" or "false".
 */
export type EmailVerificationStatus =
  | 'unverified'
  | 'valid'
  | 'invalid'
  | 'accept_all'
  | 'unknown';

/** What arrived. Decided by the classifier, never taken from the sender. */
export type InboundKind = 'reply' | 'auto_reply' | 'bounce' | 'other';

export type InboundMatchStatus = 'matched' | 'unmatched' | 'ignored';

/**
 * How a message was attributed. Recorded so that if From-address matching
 * starts producing wrong answers, there is a column that proves it.
 */
export type InboundMatchMethod = 'threading' | 'from_address' | 'manual';

export type ActivityKind =
  | 'research_edited'
  | 'personalization_edited'
  | 'draft_edited'
  | 'draft_regenerated'
  | 'draft_approved'
  | 'draft_rejected'
  | 'version_activated'
  | 'stage_completed'
  | 'notes_edited'
  | 'status_changed'
  | 'email_sent'
  | 'reply_received'
  | 'sheet_synced';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: AppRole;
          full_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          role?: AppRole;
          full_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          role?: AppRole;
          full_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      leads: {
        Row: {
          id: string;
          business_name: string;
          website: string | null;
          email: string | null;
          phone: string | null;
          city: string | null;
          country: string | null;
          niche: string | null;
          source: string | null;
          status: LeadStatus;
          research_summary: string | null;
          website_observations: string | null;
          automation_opportunities: string | null;
          ai_chatbot_opportunities: string | null;
          website_improvement_opportunities: string | null;
          personalization: string | null;
          interesting_facts: string | null;
          outreach_angle: string | null;
          social_links: Json;
          researched_at: string | null;
          subject_line: string | null;
          draft_email: string | null;
          drafted_at: string | null;
          notes: string | null;
          last_contacted_at: string | null;
          dedupe_key: string;
          import_batch_id: string | null;
          imported_at: string | null;
          sheet_row_number: number | null;
          sheet_synced_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          business_name: string;
          website?: string | null;
          email?: string | null;
          phone?: string | null;
          city?: string | null;
          country?: string | null;
          niche?: string | null;
          source?: string | null;
          status?: LeadStatus;
          research_summary?: string | null;
          website_observations?: string | null;
          automation_opportunities?: string | null;
          ai_chatbot_opportunities?: string | null;
          website_improvement_opportunities?: string | null;
          personalization?: string | null;
          interesting_facts?: string | null;
          outreach_angle?: string | null;
          social_links?: Json;
          researched_at?: string | null;
          subject_line?: string | null;
          draft_email?: string | null;
          drafted_at?: string | null;
          notes?: string | null;
          last_contacted_at?: string | null;
          dedupe_key: string;
          import_batch_id?: string | null;
          imported_at?: string | null;
          sheet_row_number?: number | null;
          sheet_synced_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['leads']['Insert']>;
        Relationships: [];
      };

      email_logs: {
        Row: {
          id: string;
          lead_id: string;
          status: EmailLogStatus;
          provider: string | null;
          message_id: string | null;
          subject: string | null;
          sent_at: string | null;
          error: string | null;
          sent_by: string | null;
          created_at: string;
          email_type: EmailType;
          email_version_id: string | null;
          /** 0040. Short stable code for why a failed send never reached (or was rejected by) the provider, e.g. 'archived', 'no_email', 'send_rejected'. Null for non-failed rows. */
          failure_reason: string | null;
        };
        Insert: {
          id?: string;
          lead_id: string;
          status?: EmailLogStatus;
          provider?: string | null;
          message_id?: string | null;
          subject?: string | null;
          sent_at?: string | null;
          error?: string | null;
          sent_by?: string | null;
          created_at?: string;
          email_type?: EmailType;
          email_version_id?: string | null;
          failure_reason?: string | null;
        };
        Update: Partial<Database['public']['Tables']['email_logs']['Insert']>;
        Relationships: [];
      };

      /**
       * Immutable draft history. Regenerating INSERTS; nothing is overwritten.
       *
       * `version_number` is filled in by a BEFORE INSERT trigger when omitted,
       * which is why it is optional on Insert but always present on Row.
       */
      email_versions: {
        Row: {
          id: string;
          lead_id: string;
          type: EmailType;
          version_number: number;
          subject: string | null;
          content: string;
          status: EmailVersionStatus;
          active: boolean;
          generated_by: string;
          created_by: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
          review_note: string | null;
          /** 0030. Set when a sweep examined this version and it still had a blocking issue. NULL on every new version. */
          sweep_checked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          type: EmailType;
          version_number?: number;
          subject?: string | null;
          content: string;
          status?: EmailVersionStatus;
          active?: boolean;
          generated_by?: string;
          created_by?: string | null;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          review_note?: string | null;
          sweep_checked_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['email_versions']['Insert']>;
        Relationships: [];
      };

      /**
       * Outreach lifecycle projection, one row per lead.
       *
       * `current_stage` is derived by trigger writing it has no effect, the
       * trigger overwrites whatever you send. It is absent from Insert/Update
       * on purpose so the type system says so too.
       */
      lead_pipeline: {
        Row: {
          lead_id: string;
          current_stage: PipelineStage;
          email_found: boolean;
          email_found_at: string | null;
          email_verified: boolean;
          email_verified_at: string | null;
          research_complete: boolean;
          research_completed_at: string | null;
          draft_ready: boolean;
          draft_ready_at: string | null;
          approved: boolean;
          approved_at: string | null;
          first_email_sent: string | null;
          followup1_due: string | null;
          followup1_sent: string | null;
          followup2_due: string | null;
          followup2_sent: string | null;
          replied: string | null;
          closed: string | null;
          closed_reason: string | null;
          auto_followups: boolean;
          email_verification_status: EmailVerificationStatus;
          email_verification_source: string | null;
          email_checked_at: string | null;
          /** The last verdict from a NON-manual source. Survives a human override. */
          email_verifier_status: EmailVerificationStatus | null;
          /** Which address the current verdict is about. */
          email_checked_address: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          lead_id: string;
          email_verification_status?: EmailVerificationStatus;
          email_verification_source?: string | null;
          email_verifier_status?: EmailVerificationStatus | null;
          email_checked_address?: string | null;
          email_checked_at?: string | null;
          email_found?: boolean;
          email_found_at?: string | null;
          email_verified?: boolean;
          email_verified_at?: string | null;
          research_complete?: boolean;
          research_completed_at?: string | null;
          draft_ready?: boolean;
          draft_ready_at?: string | null;
          approved?: boolean;
          approved_at?: string | null;
          first_email_sent?: string | null;
          followup1_due?: string | null;
          followup1_sent?: string | null;
          followup2_due?: string | null;
          followup2_sent?: string | null;
          replied?: string | null;
          closed?: string | null;
          closed_reason?: string | null;
          auto_followups?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['lead_pipeline']['Insert']>;
        Relationships: [];
      };

      /**
       * Everything that arrives at the outreach address, attributed or not.
       * `replies` holds only the genuine, matched ones.
       */
      inbound_messages: {
        Row: {
          id: string;
          from_address: string;
          from_name: string | null;
          to_address: string | null;
          subject: string | null;
          body_text: string | null;
          message_id: string | null;
          in_reply_to: string | null;
          references_header: string | null;
          received_at: string;
          kind: InboundKind;
          match_status: InboundMatchStatus;
          match_method: InboundMatchMethod | null;
          lead_id: string | null;
          email_log_id: string | null;
          reply_id: string | null;
          sentiment: ReplySentiment | null;
          confidence: number | null;
          matched_at: string | null;
          matched_by: string | null;
          is_handled: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          from_address: string;
          from_name?: string | null;
          to_address?: string | null;
          subject?: string | null;
          body_text?: string | null;
          message_id?: string | null;
          in_reply_to?: string | null;
          references_header?: string | null;
          received_at?: string;
          kind?: InboundKind;
          match_status?: InboundMatchStatus;
          match_method?: InboundMatchMethod | null;
          lead_id?: string | null;
          email_log_id?: string | null;
          reply_id?: string | null;
          sentiment?: ReplySentiment | null;
          confidence?: number | null;
          matched_at?: string | null;
          matched_by?: string | null;
          is_handled?: boolean;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['inbound_messages']['Insert']>;
        Relationships: [];
      };

      lead_activity: {
        Row: {
          id: string;
          lead_id: string;
          kind: ActivityKind;
          summary: string;
          detail: string | null;
          actor_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          kind: ActivityKind;
          summary: string;
          detail?: string | null;
          actor_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['lead_activity']['Insert']>;
        Relationships: [];
      };

      replies: {
        Row: {
          id: string;
          lead_id: string;
          email_log_id: string | null;
          reply_text: string | null;
          sentiment: ReplySentiment | null;
          confidence: number | null;
          is_handled: boolean;
          received_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          email_log_id?: string | null;
          reply_text?: string | null;
          sentiment?: ReplySentiment | null;
          confidence?: number | null;
          is_handled?: boolean;
          received_at?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['replies']['Insert']>;
        Relationships: [];
      };

      settings: {
        Row: {
          key: string;
          value: Json;
          description: string | null;
          is_sensitive: boolean;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          value: Json;
          description?: string | null;
          is_sensitive?: boolean;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['settings']['Insert']>;
        Relationships: [];
      };

      integration_secrets: {
        Row: {
          key: string;
          ciphertext: string;
          hint: string | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          ciphertext: string;
          hint?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['integration_secrets']['Insert']>;
        Relationships: [];
      };

      integration_runs: {
        Row: {
          id: string;
          integration: string;
          action: string;
          status: IntegrationRunStatus;
          message: string | null;
          stats: Json;
          started_at: string;
          finished_at: string | null;
          duration_ms: number | null;
          triggered_by: string | null;
        };
        Insert: {
          id?: string;
          integration: string;
          action: string;
          status?: IntegrationRunStatus;
          message?: string | null;
          stats?: Json;
          started_at?: string;
          finished_at?: string | null;
          duration_ms?: number | null;
          triggered_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['integration_runs']['Insert']>;
        Relationships: [];
      };
    };

    Views: {
      dashboard_email_activity_daily: {
        Row: {
          day: string;
          attempts: number;
          sent: number;
          delivered: number;
          opened: number;
          bounced: number;
          failed: number;
        };
        Relationships: [];
      };

      /* --------------------------------------------------------------------- */
      /* Pipeline (admin-only contains contact data)                          */
      /* --------------------------------------------------------------------- */

      lead_stage_counts: {
        Row: { stage: PipelineStage; lead_count: number; lead_count_all: number };
        Relationships: [];
      };

      /**
       * 0035. Machine-facing send queue for the scheduler.
       *
       * Exists because `pipeline_board` is gated `where public.is_admin()`,
       * which the service-role key never satisfies — it bypasses RLS on a
       * table, but a predicate in a view body is an ordinary WHERE clause.
       * That returned zero rows to the scheduler and stopped every automatic
       * initial send after 0028. This view is protected by grants instead
       * (revoked from anon/authenticated) and already excludes archived leads.
       */
      lead_send_queue: {
        Row: {
          lead_id: string;
          lead_status: LeadStatus;
          current_stage: PipelineStage;
          approved: boolean;
          approved_at: string | null;
          email_found: boolean;
          email_verified: boolean;
          email_verification_status: EmailVerificationStatus;
          email_verifier_status: EmailVerificationStatus | null;
          first_email_sent: string | null;
          followup1_due: string | null;
          followup1_sent: string | null;
          followup2_due: string | null;
          followup2_sent: string | null;
          replied: string | null;
          closed: string | null;
          auto_followups: boolean;
          send_priority: number;
        };
        Relationships: [];
      };

      pipeline_board: {
        Row: {
          lead_id: string;
          business_name: string;
          email: string | null;
          city: string | null;
          country: string | null;
          niche: string | null;
          lead_status: LeadStatus;
          current_stage: PipelineStage;
          next_step: PipelineNextStep;
          email_found: boolean;
          email_verified: boolean;
          research_complete: boolean;
          draft_ready: boolean;
          approved: boolean;
          approved_at: string | null;
          draft_ready_at: string | null;
          first_email_sent: string | null;
          followup1_due: string | null;
          followup1_sent: string | null;
          followup2_due: string | null;
          followup2_sent: string | null;
          replied: string | null;
          closed: string | null;
          closed_reason: string | null;
          auto_followups: boolean;
          updated_at: string;
          email_verification_status: EmailVerificationStatus;
          email_verification_source: string | null;
          email_checked_at: string | null;
          email_verifier_status: EmailVerificationStatus | null;
          email_checked_address: string | null;
          /** 1 verifier-proved · 2 hand-confirmed · 3 hand-confirmed after unknown · 9 not sendable. */
          send_priority: number;
        };
        Relationships: [];
      };

      inbound_inbox: {
        Row: {
          id: string;
          from_address: string;
          from_name: string | null;
          subject: string | null;
          body_text: string | null;
          received_at: string;
          kind: InboundKind;
          match_status: InboundMatchStatus;
          match_method: InboundMatchMethod | null;
          sentiment: ReplySentiment | null;
          is_handled: boolean;
          lead_id: string | null;
          reply_id: string | null;
          business_name: string | null;
          city: string | null;
          country: string | null;
        };
        Relationships: [];
      };

      public_stats_leads: {
        Row: {
          business_name: string;
          city: string | null;
          country: string | null;
          industry: string;
          stage: PipelineStage;
        };
        Relationships: [];
      };

      /* --------------------------------------------------------------------- */
      /* PUBLIC anon-readable. Aggregates only; see migration 0013 before      */
      /* adding a single column here.                                           */
      /* --------------------------------------------------------------------- */

      public_stats_overview: {
        Row: {
          total_leads: number;
          need_email: number;
          need_verification: number;
          researching: number;
          awaiting_draft: number;
          draft_ready: number;
          approved: number;
          closed: number;
          emails_sent: number;
          emails_attempted: number;
          emails_bounced: number;
          initial_sent: number;
          followup1_sent: number;
          followup2_sent: number;
          replies: number;
          positive_replies: number;
          negative_replies: number;
          neutral_replies: number;
          bounce_rate_pct: number | null;
          reply_rate_pct: number | null;
          avg_response_hours: number | null;
          dead_email: number;
          /** 0036. Distinct non-archived leads with an initial send — businesses reached, not messages sent. */
          leads_contacted: number;
        };
        Relationships: [];
      };
      public_stats_stages: {
        Row: { stage: PipelineStage; lead_count: number; pct_of_total: number | null };
        Relationships: [];
      };
      public_stats_activity_daily: {
        Row: {
          day: string;
          emails_sent: number;
          emails_bounced: number;
          replies: number;
          positive_replies: number;
          negative_replies: number;
        };
        Relationships: [];
      };

      /* --------------------------------------------------------------------- */
      /* Analytics (admin-only)                                                 */
      /* --------------------------------------------------------------------- */

      analytics_email_weekly: {
        Row: { week_start: string; attempts: number; sent: number; bounced: number; failed: number };
        Relationships: [];
      };
      analytics_email_monthly: {
        Row: { month_start: string; attempts: number; sent: number; bounced: number; failed: number };
        Relationships: [];
      };
      analytics_reply_rate_daily: {
        Row: { day: string; sent: number; replies: number; reply_rate_pct: number | null };
        Relationships: [];
      };
      analytics_funnel_timing: {
        Row: {
          avg_approval_hours: number | null;
          avg_send_delay_hours: number | null;
          avg_reply_hours: number | null;
          avg_drafting_hours: number | null;
          approved_sample: number;
          sent_sample: number;
        };
        Relationships: [];
      };
      analytics_industry_performance: {
        Row: {
          industry: string;
          leads: number;
          emails_sent: number;
          followups_sent: number;
          replies_received: number;
          positive_replies: number;
          reply_rate_pct: number | null;
        };
        Relationships: [];
      };
      analytics_stage_distribution: {
        Row: { stage: PipelineStage; lead_count: number; pct_of_total: number | null };
        Relationships: [];
      };
      analytics_followup_conversion: {
        Row: {
          step: EmailType;
          step_order: number;
          sent: number;
          replies: number;
          reply_rate_pct: number | null;
        };
        Relationships: [];
      };
      analytics_generation_daily: {
        Row: {
          day: string;
          generated_by: string;
          versions_created: number;
          approved: number;
          rejected: number;
        };
        Relationships: [];
      };
    };

    Functions: {
      current_app_role: { Args: Record<string, never>; Returns: AppRole };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      is_app_user: { Args: Record<string, never>; Returns: boolean };
    };

    Enums: {
      app_role: AppRole;
      lead_status: LeadStatus;
      email_log_status: EmailLogStatus;
      reply_sentiment: ReplySentiment;
      integration_run_status: IntegrationRunStatus;
      email_type: EmailType;
      email_version_status: EmailVersionStatus;
      email_verification_status: EmailVerificationStatus;
      inbound_kind: InboundKind;
      inbound_match_status: InboundMatchStatus;
      inbound_match_method: InboundMatchMethod;
      pipeline_stage: PipelineStage;
      pipeline_next_step: PipelineNextStep;
      activity_kind: ActivityKind;
    };

    CompositeTypes: Record<string, never>;
  };
}

/* ------------------------------------------------------------------------- */
/* Convenience aliases                                                        */
/* ------------------------------------------------------------------------- */

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update'];
export type Views<T extends keyof PublicSchema['Views']> = PublicSchema['Views'][T]['Row'];

export type Profile = Tables<'profiles'>;
export type Lead = Tables<'leads'>;
export type LeadInsert = TablesInsert<'leads'>;
export type EmailLog = Tables<'email_logs'>;
export type Reply = Tables<'replies'>;
export type Setting = Tables<'settings'>;
export type IntegrationRun = Tables<'integration_runs'>;
export type EmailVersion = Tables<'email_versions'>;
export type EmailVersionInsert = TablesInsert<'email_versions'>;
export type LeadPipeline = Tables<'lead_pipeline'>;
export type LeadPipelineUpdate = TablesUpdate<'lead_pipeline'>;
export type LeadActivity = Tables<'lead_activity'>;
export type InboundMessage = Tables<'inbound_messages'>;
export type InboundInboxRow = Views<'inbound_inbox'>;
export type PipelineBoardRow = Views<'pipeline_board'>;

export const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'researching',
  'ready',
  'approved',
  'sending',
  'sent',
  'replied',
  'bounced',
  'invalid',
  'archived',
] as const;

export const APP_ROLES: readonly AppRole[] = ['admin', 'viewer'] as const;

/** Sequence order. Used for tab order and for resolving "what comes next". */
export const EMAIL_TYPES: readonly EmailType[] = ['initial', 'followup1', 'followup2'] as const;

export const EMAIL_VERIFICATION_STATUSES: readonly EmailVerificationStatus[] = [
  'unverified',
  'valid',
  'accept_all',
  'unknown',
  'invalid',
] as const;

/** Earliest to latest. Ordering a board by this array matches the SQL enum order. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'need_email',
  'dead_email',
  'need_verification',
  'research',
  'draft',
  'review',
  'approved',
  'initial_sent',
  'followup1_sent',
  'followup2_sent',
  'replied',
  'closed',
] as const;
