"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bot, Loader2, Send, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { StepHandle } from "../journey-types";
import {
  AGENT_INSTRUCTION_MAX_LENGTH,
  isAgentInstructionValid,
} from "@/lib/agent/policy";

const DEFAULT_QUESTION = "Which pets are overdue for vaccines?";

const EXAMPLE_QUESTION = "Which pets are overdue for vaccines?";
const EXAMPLE_ANSWER =
  "Two of your sample pets look overdue. Biscuit is past due for the DHPP shot, and Luna is coming up soon. Want me to draft a friendly reminder you can send to each owner?";

/** A short, clearly-labeled sample so users see the value even with no AI key. */
function ExampleChat() {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        Example
      </div>
      <div className="space-y-3">
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-800">
            {EXAMPLE_QUESTION}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
            <Bot className="h-3.5 w-3.5" />
          </span>
          <div className="max-w-[85%] rounded-lg bg-emerald-50/70 px-3 py-2 text-sm leading-relaxed text-slate-700">
            {EXAMPLE_ANSWER}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Step 5: let the user try the built-in AI helper. If no key is set yet, show a
 * friendly note instead. Continue never blocks here.
 */
export function TryAgentStep({
  register,
}: {
  register: (h: StepHandle) => void;
}) {
  const status = trpc.agent.status.useQuery();
  const run = trpc.agent.run.useMutation();
  const [question, setQuestion] = useState(DEFAULT_QUESTION);

  useEffect(() => {
    register({ onContinue: async () => true });
  }, [register]);

  const statusMissing = !status.isLoading && !status.error && !status.data;
  const verifiedAgentStatus =
    status.error || statusMissing || !status.data ? null : status.data;
  const configured = verifiedAgentStatus
    ? verifiedAgentStatus.configured
    : false;
  const questionInvalid =
    question.length > 0 && !isAgentInstructionValid(question);
  const canAsk = Boolean(
    verifiedAgentStatus &&
    configured &&
    isAgentInstructionValid(question) &&
    !run.isPending
  );

  function ask() {
    if (!canAsk) return;
    run.mutate({ instruction: question.trim() });
  }

  if (status.isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status.error || statusMissing) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">
              {statusMissing
                ? "AI helper status is unavailable"
                : "AI helper status could not load"}
            </p>
            <p className="mt-1 text-slate-600">
              {status.error?.message ??
                "AI helper configuration could not be verified. Please retry before asking the helper."}
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
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600">
          AI is built right into OpenVPM. It can answer questions about your
          clinic in plain words.
        </p>
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Your AI helper turns on once your AI key is set. You can try it any
            time from the Agent page.
          </p>
        </div>
        <ExampleChat />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-slate-600">
        AI is built right in. Ask a question about your clinic and see what comes
        back.
      </p>

      <ExampleChat />

      <div className="flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask();
          }}
          maxLength={AGENT_INSTRUCTION_MAX_LENGTH}
          aria-invalid={questionInvalid || undefined}
          placeholder="Ask your AI helper something"
          aria-label="Ask your AI helper"
        />
        <Button type="button" onClick={ask} disabled={!canAsk}>
          {run.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-1.5 h-4 w-4" />
          )}
          Ask
        </Button>
      </div>

      {run.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {run.error.message}
        </div>
      ) : null}

      {run.data ? (
        <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-emerald-700">
            <Bot className="h-3.5 w-3.5" />
            Your AI helper
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {run.data.text}
          </div>
        </div>
      ) : null}
    </div>
  );
}
