import { NextResponse } from "next/server";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Content/newsletter subscribe. Captures to Slack today (same channel as the
// waitlist) so no signup is lost; point this at a real ESP list when one is
// wired (see the co-founder memo / growth playbook).
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = body.email?.trim();
    const source = body.source?.trim() || "site";

    if (!email || !EMAIL_REGEX.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("Missing SLACK_WEBHOOK_URL");
      return NextResponse.json(
        { error: "Subscribe is temporarily unavailable." },
        { status: 503 }
      );
    }

    const slackPayload = {
      text: `New OpenVPM subscriber — ${email}`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "📰 New OpenVPM subscriber" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Email:*\n${email}` },
            { type: "mrkdwn", text: `*Source:*\n${source}` },
          ],
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `openvpm.com · ${new Date().toISOString()}` },
          ],
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    });

    if (!res.ok) {
      console.error("Slack webhook error:", res.status, await res.text());
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Subscribe error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
