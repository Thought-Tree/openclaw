/**
 * Barnyard Tracker Plugin
 *
 * Pushes OpenClaw agent lifecycle events into the Barnyard knowledge graph
 * as first-class TextNodes, where they go through the full enrichment pipeline
 * (entity extraction, relation mapping, TopicCluster creation).
 *
 * Tracked events:
 *   - inbound_claim  → record_type: "agent_query"    (incoming user message)
 *   - after_compaction → record_type: "context_compact" (context window compaction)
 *   - agent_end      → record_type: "agent_summary"  (final assistant response)
 *
 * Configuration (in order of priority):
 *   1. Plugin config (via OpenClaw settings UI)
 *   2. Environment variables: SCHEME_MCP_URL, SCHEME_AGENT_HOOK_KEY
 *   3. Defaults: url="http://localhost:8001"
 *
 * The plugin degrades silently if the endpoint is unreachable — it never
 * blocks or throws in a way that could affect the agent's operation.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/core";

interface BarnyardTrackerConfig {
  url?: string;
  hookKey?: string | { secretRef?: string; value?: string };
  enabled?: boolean;
}

interface AgentEventPayload {
  event_type: string;
  summary: string;
  session_id?: string;
  tokens_before?: number;
  tokens_after?: number;
}

export default definePluginEntry({
  id: "barnyard-tracker",
  name: "Barnyard Tracker",
  description: "Push agent events into the Barnyard knowledge graph as TextNodes",

  register(api) {
    const config = (api.config ?? {}) as BarnyardTrackerConfig;

    // Resolve URL and hook key from config or environment
    const baseUrl =
      config.url?.trim() ||
      (typeof process !== "undefined" ? process.env.SCHEME_MCP_URL : undefined) ||
      "http://localhost:8001";

    const rawKey = config.hookKey;
    const hookKey =
      typeof rawKey === "string"
        ? rawKey
        : typeof rawKey === "object" && rawKey !== null && "value" in rawKey
          ? (rawKey.value ?? "")
          : (typeof process !== "undefined" ? process.env.SCHEME_AGENT_HOOK_KEY : undefined) ?? "";

    const enabled = config.enabled !== false;

    if (!enabled) {
      return;
    }

    if (!hookKey) {
      api.logger.warn(
        "barnyard-tracker: no hook key configured — " +
          "set SCHEME_AGENT_HOOK_KEY or configure hookKey in plugin settings. " +
          "Agent events will not be tracked.",
      );
      return;
    }

    /**
     * Push an event to Barnyard's /agent/event hook endpoint.
     * Fully fire-and-forget: errors are logged but never re-thrown.
     */
    async function push(payload: AgentEventPayload): Promise<void> {
      try {
        const res = await fetch(`${baseUrl}/agent/event`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Hook-Key": hookKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          api.logger.warn(
            `barnyard-tracker: /agent/event returned ${res.status} for event_type=${payload.event_type}`,
          );
        }
      } catch (err) {
        // Best-effort: swallow all errors so the agent is never blocked
        api.logger.warn(
          `barnyard-tracker: failed to push ${payload.event_type}: ${String(err)}`,
        );
      }
    }

    /** Extract the last assistant text from a message list (Anthropic-style). */
    function extractLastAssistantText(messages: unknown[]): string {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (
          typeof msg === "object" &&
          msg !== null &&
          "role" in msg &&
          (msg as { role: unknown }).role === "assistant"
        ) {
          const content = (msg as { content: unknown }).content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            const texts: string[] = [];
            for (const block of content) {
              if (
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                (block as { type: unknown }).type === "text" &&
                "text" in block
              ) {
                texts.push(String((block as { text: unknown }).text));
              }
            }
            if (texts.length > 0) return texts.join("\n");
          }
        }
      }
      return "";
    }

    // ── Hook: inbound_claim — capture the incoming user query ─────────────────
    api.on(
      "inbound_claim",
      async (event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => {
        const text = (event.bodyForAgent ?? event.content ?? "").trim();
        if (!text) return;
        void push({
          event_type: "agent_query",
          summary: text,
          session_id: ctx.conversationId ?? ctx.parentConversationId,
        });
      },
    );

    // ── Hook: after_compaction — capture context compaction events ─────────────
    api.on(
      "after_compaction",
      async (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => {
        const summary =
          `Context compacted: ${event.compactedCount} of ${event.messageCount} ` +
          `messages condensed` +
          (event.tokenCount != null ? ` (${event.tokenCount} tokens)` : "");
        void push({
          event_type: "context_compact",
          summary,
          session_id: ctx.sessionKey ?? ctx.sessionId,
          tokens_before: event.tokenCount,
          tokens_after: 0,
        });
      },
    );

    // ── Hook: agent_end — capture the final assistant response ─────────────────
    api.on(
      "agent_end",
      async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
        if (!event.success) return; // skip errored runs — no meaningful summary
        const text = extractLastAssistantText(event.messages);
        if (!text) return;
        void push({
          event_type: "agent_summary",
          summary: text,
          session_id: ctx.sessionKey ?? ctx.sessionId,
        });
      },
    );
  },
});
