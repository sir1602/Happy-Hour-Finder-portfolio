export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      content_audit_log: {
        Row: {
          action: string
          confidence: number | null
          created_at: string
          entity_id: string | null
          entity_type: string
          field_changes: Json
          id: string
          reason: string | null
          source: string | null
        }
        Insert: {
          action: string
          confidence?: number | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          field_changes?: Json
          id?: string
          reason?: string | null
          source?: string | null
        }
        Update: {
          action?: string
          confidence?: number | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          field_changes?: Json
          id?: string
          reason?: string | null
          source?: string | null
        }
        Relationships: []
      }
      deals: {
        Row: {
          confidence: number | null
          created_at: string | null
          days_active: number[] | null
          description: string | null
          ends_in: string | null
          id: string
          image_url: string | null
          last_verified_at: string | null
          parent_deal_id: string | null
          price_level: number | null
          search_vector: unknown
          source: string | null
          source_url: string | null
          status: Database["public"]["Enums"]["deal_status"]
          submitted_by: string | null
          tags: string[] | null
          time_window: string
          title: string
          type: string | null
          updated_at: string
          venue_id: string
          verification_status: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          days_active?: number[] | null
          description?: string | null
          ends_in?: string | null
          id?: string
          image_url?: string | null
          last_verified_at?: string | null
          parent_deal_id?: string | null
          price_level?: number | null
          search_vector?: unknown
          source?: string | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["deal_status"]
          submitted_by?: string | null
          tags?: string[] | null
          time_window: string
          title: string
          type?: string | null
          updated_at?: string
          venue_id: string
          verification_status?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          days_active?: number[] | null
          description?: string | null
          ends_in?: string | null
          id?: string
          image_url?: string | null
          last_verified_at?: string | null
          parent_deal_id?: string | null
          price_level?: number | null
          search_vector?: unknown
          source?: string | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["deal_status"]
          submitted_by?: string | null
          tags?: string[] | null
          time_window?: string
          title?: string
          type?: string | null
          updated_at?: string
          venue_id?: string
          verification_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_parent_deal_id_fkey"
            columns: ["parent_deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          context: Json | null
          created_at: string
          deal_id: string | null
          id: string
          kind: string
          message: string
          user_id: string | null
        }
        Insert: {
          context?: Json | null
          created_at?: string
          deal_id?: string | null
          id?: string
          kind: string
          message: string
          user_id?: string | null
        }
        Update: {
          context?: Json | null
          created_at?: string
          deal_id?: string | null
          id?: string
          kind?: string
          message?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feedback_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      hh_photo_scans: {
        Row: {
          created_at: string
          id: string
          image_url: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_url?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          image_url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      metros: {
        Row: {
          active: boolean
          center_lat: number
          center_lng: number
          created_at: string
          geocode_suffix: string | null
          id: string
          name: string
          radius_km: number
          slug: string
          timezone: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          center_lat: number
          center_lng: number
          created_at?: string
          geocode_suffix?: string | null
          id?: string
          name: string
          radius_km?: number
          slug: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          center_lat?: number
          center_lng?: number
          created_at?: string
          geocode_suffix?: string | null
          id?: string
          name?: string
          radius_km?: number
          slug?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string
          expo_push_token: string | null
          id: string
          notification_preferences: Json | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          expo_push_token?: string | null
          id: string
          notification_preferences?: Json | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          expo_push_token?: string | null
          id?: string
          notification_preferences?: Json | null
        }
        Relationships: []
      }
      reviews: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          rating: number
          user_id: string
          venue_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          rating: number
          user_id: string
          venue_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          rating?: number
          user_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      user_badges: {
        Row: {
          badge_id: string
          earned_at: string
          id: string
          user_id: string
        }
        Insert: {
          badge_id: string
          earned_at?: string
          id?: string
          user_id: string
        }
        Update: {
          badge_id?: string
          earned_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      user_deals: {
        Row: {
          created_at: string
          deal_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deal_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          deal_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_deals_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_deals_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_rewards: {
        Row: {
          current_streak: number | null
          deals_submitted: number | null
          id: string
          level: number | null
          longest_streak: number | null
          total_points: number | null
          total_reviews: number | null
          total_visits: number | null
          unique_venues_visited: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          current_streak?: number | null
          deals_submitted?: number | null
          id?: string
          level?: number | null
          longest_streak?: number | null
          total_points?: number | null
          total_reviews?: number | null
          total_visits?: number | null
          unique_venues_visited?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          current_streak?: number | null
          deals_submitted?: number | null
          id?: string
          level?: number | null
          longest_streak?: number | null
          total_points?: number | null
          total_reviews?: number | null
          total_visits?: number | null
          unique_venues_visited?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_visits: {
        Row: {
          deal_id: string | null
          id: string
          notes: string | null
          user_id: string
          venue_id: string
          visited_at: string
        }
        Insert: {
          deal_id?: string | null
          id?: string
          notes?: string | null
          user_id: string
          venue_id: string
          visited_at?: string
        }
        Update: {
          deal_id?: string | null
          id?: string
          notes?: string | null
          user_id?: string
          venue_id?: string
          visited_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_visits_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_visits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_visits_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string
          created_at: string | null
          google_place_id: string | null
          id: string
          image_checked_at: string | null
          image_source: string | null
          image_source_url: string | null
          image_url: string | null
          last_verified_at: string | null
          latitude: number
          longitude: number
          metro_id: string | null
          name: string
          neighborhood: string
          permanently_closed: boolean
          phone: string | null
          rating: number | null
          review_count: number | null
          source: string | null
          source_url: string | null
          submitted_by: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          address: string
          created_at?: string | null
          google_place_id?: string | null
          id?: string
          image_checked_at?: string | null
          image_source?: string | null
          image_source_url?: string | null
          image_url?: string | null
          last_verified_at?: string | null
          latitude: number
          longitude: number
          metro_id?: string | null
          name: string
          neighborhood: string
          permanently_closed?: boolean
          phone?: string | null
          rating?: number | null
          review_count?: number | null
          source?: string | null
          source_url?: string | null
          submitted_by?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          address?: string
          created_at?: string | null
          google_place_id?: string | null
          id?: string
          image_checked_at?: string | null
          image_source?: string | null
          image_source_url?: string | null
          image_url?: string | null
          last_verified_at?: string | null
          latitude?: number
          longitude?: number
          metro_id?: string | null
          name?: string
          neighborhood?: string
          permanently_closed?: boolean
          phone?: string | null
          rating?: number | null
          review_count?: number | null
          source?: string | null
          source_url?: string | null
          submitted_by?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venues_metro_id_fkey"
            columns: ["metro_id"]
            isOneToOne: false
            referencedRelation: "metros"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      hh_data_quality_issues: {
        Row: {
          detail: string | null
          entity_id: string | null
          entity_type: string | null
          issue: string | null
          label: string | null
        }
        Relationships: []
      }
      hh_duplicate_deals: {
        Row: {
          copies: number | null
          deal_ids: string[] | null
          normalized_title: string | null
          titles: string[] | null
          venue_id: string | null
          venue_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      award_badge: { Args: { p_badge_id: string }; Returns: boolean }
      delete_user_account: { Args: never; Returns: undefined }
      get_public_profiles: {
        Args: { p_user_ids: string[] }
        Returns: {
          avatar_url: string
          display_name: string
          id: string
        }[]
      }
      hh_attach_venue_image: {
        Args: { p_image_url: string; p_venue_id: string }
        Returns: Json
      }
      hh_claim_photo_scan: { Args: { p_image_url?: string }; Returns: Json }
      hh_deals_needing_verification: {
        Args: { p_limit?: number }
        Returns: {
          confidence: number
          days_active: number[]
          deal_id: string
          description: string
          last_verified_at: string
          price_level: number
          source_url: string
          status: Database["public"]["Enums"]["deal_status"]
          time_window: string
          title: string
          venue_address: string
          venue_id: string
          venue_name: string
          venue_neighborhood: string
          website: string
        }[]
      }
      hh_distance_km: {
        Args: { p_lat1: number; p_lat2: number; p_lng1: number; p_lng2: number }
        Returns: number
      }
      hh_intake_deal: { Args: { p_payload: Json }; Returns: Json }
      hh_is_valid_time_window: { Args: { p_input: string }; Returns: boolean }
      hh_norm_text: { Args: { p_input: string }; Returns: string }
      hh_record_venue_image: {
        Args: {
          p_image_url?: string
          p_outcome?: string
          p_source_url?: string
          p_venue_id: string
        }
        Returns: Json
      }
      hh_record_verification: {
        Args: {
          p_deal_id: string
          p_extracted?: Json
          p_notes?: string
          p_source_url?: string
          p_verdict: string
        }
        Returns: Json
      }
      hh_reopen_decision: {
        Args: { p_deal_id: string; p_note?: string }
        Returns: Json
      }
      hh_review_batch: {
        Args: { p_action?: string; p_items: Json; p_note?: string }
        Returns: Json
      }
      hh_review_deal: {
        Args: { p_action: string; p_deal_id: string }
        Returns: Json
      }
      hh_review_deal_v2: {
        Args: {
          p_action?: string
          p_deal_id: string
          p_edits?: Json
          p_note?: string
        }
        Returns: Json
      }
      hh_review_proposal: {
        Args: { p_action: string; p_proposal_id: string }
        Returns: Json
      }
      hh_review_proposal_v2: {
        Args: {
          p_action?: string
          p_edits?: Json
          p_note?: string
          p_proposal_id: string
        }
        Returns: Json
      }
      hh_update_venue_fields: {
        Args: { p_edits?: Json; p_note?: string; p_venue_id: string }
        Returns: Json
      }
      hh_venues_needing_image: {
        Args: { p_limit?: number }
        Returns: {
          name: string
          neighborhood: string
          venue_id: string
          website: string
        }[]
      }
      increment_rewards: {
        Args: { p_action: string }
        Returns: {
          current_streak: number | null
          deals_submitted: number | null
          id: string
          level: number | null
          longest_streak: number | null
          total_points: number | null
          total_reviews: number | null
          total_visits: number | null
          unique_venues_visited: number | null
          updated_at: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "user_rewards"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      search_deals: {
        Args: {
          center_lat?: number
          center_lng?: number
          day_filter?: number
          deal_type?: string
          neighborhood_filter?: string
          price_max?: number
          radius_km?: number
          row_limit?: number
          row_offset?: number
          search_query: string
          tag_filter?: string[]
        }
        Returns: Json
      }
    }
    Enums: {
      deal_status: "active" | "pending" | "rejected" | "expired"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      deal_status: ["active", "pending", "rejected", "expired"],
    },
  },
} as const
