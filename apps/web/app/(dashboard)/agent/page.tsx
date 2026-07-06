"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Bot,
  Send,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Wrench,
  Loader2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import {
  AGENT_INSTRUCTION_MAX_LENGTH,
  isAgentInstructionValid,
} from "@/lib/agent/policy";

const SUGGESTIONS = [
  "Which patients are overdue for vaccinations?",
  "Summarize today's appointments.",
  "What's the carprofen dose for a 12 kg dog?",
  "Pull a clinical summary for the next patient checked in.",
];

function canRunAgentRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

export default function AgentPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking agent access...
        </div>
      </div>
    );
  }

  if (!canRunAgentRole(session?.user?.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={Bot}
          title="Agent access is restricted"
          description="Only administrators and veterinarians can run the OpenVPM Agent."
          action={{
            label: "Back to dashboard",
            onClick: () => router.push("/"),
          }}
        />
      </div>
    );
  }

  return <AgentRunner />;
}

function AgentRunner() {
  const status = trpc.agent.status.useQuery();
  const run = trpc.agent.run.useMutation();
  const [instruction, setInstruction] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  const statusMissing = !status.isLoading && !status.error && !status.data;
  const verifiedAgentStatus =
    status.error || statusMissing || !status.data ? null : status.data;
  const configured = verifiedAgentStatus
    ? verifiedAgentStatus.configured
    : false;
  const canRun = !status.isLoading && configured;
  const instructionInvalid =
    instruction.length > 0 && !isAgentInstructionValid(instruction);
  const submitDisabled =
    !canRun || !isAgentInstructionValid(instruction) || run.isPending;

  useEffect(() => {
    if (!canRun && allowWrites) {
      setAllowWrites(false);
    }
  }, [allowWrites, canRun]);

  function submit() {
    if (submitDisabled) return;
    run.mutate(
      { instruction: instruction.trim(), allowWrites },
      { onSettled: () => setAllowWrites(false) }
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Bot className="h-5 w-5" />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-semibold">OpenVPM Agent</h1>
          <p className="text-sm text-muted-foreground">
            Ask the agent to work on your practice data. It uses real tools and
            never invents records.
          </p>
        </div>
      </div>

      {status.isLoading ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking agent configuration...
        </div>
      ) : status.error ? (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Could not check agent status</p>
            <p className="mt-1">{status.error.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void status.refetch()}
              className="mt-3"
            >
              Retry
            </Button>
          </div>
        </div>
      ) : statusMissing ? (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Agent status is unavailable</p>
            <p className="mt-1">
              Agent configuration could not be verified. Please retry before
              running the agent.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void status.refetch()}
              className="mt-3"
            >
              Retry
            </Button>
          </div>
        </div>
      ) : !configured ? (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            The agent is not configured yet. Set{" "}
            <code className="break-all font-mono">GOOGLE_API_KEY</code> or{" "}
            <code className="break-all font-mono">GOOGLE_GENERATIVE_AI_API_KEY</code>{" "}
            for Gemini, or <code className="break-all font-mono">ANTHROPIC_API_KEY</code>{" "}
            for Claude, to enable agent runs.
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-surface p-4">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          rows={3}
          maxLength={AGENT_INSTRUCTION_MAX_LENGTH}
          aria-invalid={instructionInvalid || undefined}
          disabled={!canRun || run.isPending}
          placeholder={
            canRun
              ? "Ask the agent to do something...  (Cmd/Ctrl + Enter to run)"
              : "Agent runs are unavailable until configuration is verified."
          }
          className="w-full resize-none rounded-md border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
        <div className="mt-3 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={allowWrites}
              onChange={(e) => setAllowWrites(e.target.checked)}
              disabled={!canRun || run.isPending}
              className="h-4 w-4 rounded border-border"
            />
            Allow writes: appointments, vitals, and SOAP notes
          </label>
          <Button onClick={submit} disabled={submitDisabled}>
            <Send className="mr-1.5 h-4 w-4" />
            {run.isPending ? "Working…" : "Run"}
          </Button>
        </div>
        {allowWrites && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              Write mode can create appointments, record vitals, or save SOAP
              notes. It turns off automatically after this run.
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setInstruction(s)}
            disabled={!canRun || run.isPending}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      {run.error && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {run.error.message}
        </div>
      )}

      {run.data && (
        <div className="mt-6 rounded-xl border border-border bg-background p-5">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {run.data.text}
          </div>

          {run.data.toolCalls.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <button
                onClick={() => setTraceOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {traceOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <Wrench className="h-3.5 w-3.5" />
                {run.data.toolCalls.length} tool call
                {run.data.toolCalls.length === 1 ? "" : "s"}
              </button>
              {traceOpen && (
                <ul className="mt-2 space-y-2">
                  {run.data.toolCalls.map((call, i) => (
                    <li
                      key={i}
                      className={cn(
                        "rounded-md border p-2 font-mono text-xs",
                        call.error
                          ? "border-destructive/30 bg-destructive/5 text-destructive"
                          : "border-border bg-surface text-muted-foreground"
                      )}
                    >
                      <div className="font-semibold text-foreground">{call.name}</div>
                      <div className="mt-1 break-all">
                        {JSON.stringify(call.input)}
                      </div>
                      {call.error && <div className="mt-1">⚠ {call.error}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
