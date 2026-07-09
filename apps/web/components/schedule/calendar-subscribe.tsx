"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { CalendarPlus, Copy, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  emitGuideSignal,
  GUIDE_SIGNALS,
} from "@/components/tour/guide-signals";

/**
 * "Add to your calendar" on the schedule header: turns on and shares the
 * practice-wide ICS subscription URL. Lives here (not in Settings) so front
 * desk staff can reach it; Settings is admin-only in the sidebar.
 */
export function CalendarSubscribe() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const utils = trpc.useUtils();
  const feed = trpc.appointments.calendarFeed.useQuery();
  const [confirmRotate, setConfirmRotate] = useState(false);

  const enable = trpc.appointments.enableCalendarFeed.useMutation({
    onSuccess: (data) => {
      utils.appointments.calendarFeed.setData(undefined, { url: data.url });
    },
    onError: (err) => toast.error(err.message),
  });
  const rotate = trpc.appointments.rotateCalendarFeed.useMutation({
    onSuccess: (data) => {
      utils.appointments.calendarFeed.setData(undefined, { url: data.url });
      setConfirmRotate(false);
      toast.success("New calendar link created. The old one stopped working.");
    },
    onError: (err) => toast.error(err.message),
  });

  const url = feed.data?.url ?? null;

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Calendar link copied");
      emitGuideSignal(GUIDE_SIGNALS.calendarUrlCopied);
    } catch {
      toast.error("Could not copy the link");
    }
  };

  return (
    <Popover onOpenChange={() => setConfirmRotate(false)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-tour="calendar-subscribe">
          <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
          Add to your calendar
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <h4 className="font-heading text-sm font-semibold">
          Your schedule, in your calendar
        </h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Subscribe once and the clinic schedule stays up to date in Google,
          Apple, or Outlook on its own. The link shows patient names and visit
          types only, so share it with staff, not clients.
        </p>

        {feed.isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking the feed...
          </div>
        ) : feed.error ? (
          <div className="mt-3 text-xs text-destructive">
            Could not load the feed.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void feed.refetch()}
            >
              Retry
            </button>
          </div>
        ) : url ? (
          <>
            <div className="mt-3 break-all rounded-md border border-border bg-muted px-2.5 py-2 font-mono text-[11px]">
              {url}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              In your calendar app, look for &quot;subscribe by URL&quot; or
              &quot;from internet&quot; and paste the link.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={copyUrl} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                Copy link
              </Button>
              {isAdmin ? (
                <Button
                  variant={confirmRotate ? "destructive" : "outline"}
                  size="sm"
                  disabled={rotate.isPending}
                  onClick={() =>
                    confirmRotate ? rotate.mutate() : setConfirmRotate(true)
                  }
                  className="gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {rotate.isPending
                    ? "Updating..."
                    : confirmRotate
                      ? "Confirm new link"
                      : "Get a new link"}
                </Button>
              ) : null}
            </div>
            {confirmRotate ? (
              <p className="mt-2 text-xs text-amber-700">
                A new link stops the old one for everyone who subscribed.
              </p>
            ) : null}
          </>
        ) : (
          <Button
            size="sm"
            className="mt-3"
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
          >
            {enable.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Turning on...
              </>
            ) : (
              "Turn on the calendar link"
            )}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
