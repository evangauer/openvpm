"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/common/empty-state";
import { formatPortalDateTime } from "@/lib/portal/date";
import { COMMUNICATION_CONTENT_MAX_LENGTH } from "@/lib/communications/policy";

export default function PortalMessagesPage() {
  const [content, setContent] = useState("");
  const utils = trpc.useUtils();

  const { data, isLoading, error } = trpc.portal.getMessages.useQuery(
    {},
    { refetchInterval: 30000 }
  );
  const sendMessage = trpc.portal.createMessage.useMutation({
    onSuccess: () => {
      setContent("");
      toast.success("Message sent");
      utils.portal.getMessages.invalidate({});
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const markMessagesRead = trpc.portal.markMessagesRead.useMutation({
    onSuccess: () => {
      utils.portal.getMessages.invalidate({});
    },
  });

  const messages = useMemo(() => {
    return [...(data?.items ?? [])].reverse();
  }, [data?.items]);
  const unreadClinicMessageIds = useMemo(() => {
    const ids = (data?.items ?? [])
      .filter(
        (message) =>
          message.direction === "outbound" &&
          !message.readAt &&
          message.status !== "read"
      )
      .map((message) => message.id);
    return ids.length > 0 ? ids.join(",") : "";
  }, [data?.items]);
  const markedReadSignature = useRef<string | null>(null);
  const trimmedContent = content.trim();
  const canSend =
    trimmedContent.length > 0 &&
    trimmedContent.length <= COMMUNICATION_CONTENT_MAX_LENGTH &&
    !sendMessage.isPending;

  useEffect(() => {
    if (
      !unreadClinicMessageIds ||
      markMessagesRead.isPending ||
      markedReadSignature.current === unreadClinicMessageIds
    ) {
      return;
    }

    markedReadSignature.current = unreadClinicMessageIds;
    markMessagesRead.mutate({});
  }, [markMessagesRead, unreadClinicMessageIds]);

  function handleSend() {
    if (!canSend) return;
    sendMessage.mutate({
      content: trimmedContent,
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-xl">
        <EmptyState
          className="py-12"
          icon={AlertCircle}
          title="Unable to load messages"
          description="Please refresh this page or contact your clinic if the portal link has expired."
        />
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/portal"
        className="mb-6 inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to portal
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
        <p className="mt-1 text-gray-500">
          Send questions and follow-ups directly to your clinic.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="max-h-[520px] min-h-[280px] space-y-4 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <EmptyState
              className="border-0 py-10"
              icon={MessageSquare}
              title="No portal messages yet"
              description="Messages from your clinic and your replies will appear here."
            />
          ) : (
            messages.map((message) => {
              const isClientMessage = message.direction === "inbound";
              return (
                <div
                  key={message.id}
                  className={`flex ${isClientMessage ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[82%] rounded-xl px-4 py-3 text-sm ${
                      isClientMessage
                        ? "bg-primary text-primary-foreground"
                        : "border border-gray-200 bg-gray-50 text-gray-900"
                    }`}
                  >
                    {message.subject && !isClientMessage ? (
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        {message.subject}
                      </p>
                    ) : null}
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {message.content}
                    </p>
                    <p
                      className={`mt-2 text-xs ${
                        isClientMessage
                          ? "text-primary-foreground/80"
                          : "text-gray-500"
                      }`}
                    >
                      {isClientMessage ? "You" : "Clinic"} -{" "}
                      {formatPortalDateTime(
                        message.createdAt,
                        undefined,
                        data.timezone
                      )}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-gray-200 p-4">
          <label className="sr-only" htmlFor="portal-message-content">
            Message
          </label>
          <textarea
            id="portal-message-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={COMMUNICATION_CONTENT_MAX_LENGTH}
            rows={3}
            placeholder="Type your message..."
            className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">
              {trimmedContent.length}/{COMMUNICATION_CONTENT_MAX_LENGTH}
            </p>
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              {sendMessage.isPending ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
