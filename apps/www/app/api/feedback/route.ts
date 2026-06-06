import { NextResponse } from "next/server";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const message = body.message?.trim();
    const name = body.name?.trim() || undefined;
    const email = body.email?.trim() || undefined;
    const context = body.context?.trim() || undefined; // e.g. which page/feature

    if (!message || message.length < 3) {
      return NextResponse.json(
        { error: "Please enter a bit more detail." },
        { status: 400 }
      );
    }
    if (message.length > 5000) {
      return NextResponse.json(
        { error: "That's a lot — please keep it under 5000 characters." },
        { status: 400 }
      );
    }
    if (email && !EMAIL_REGEX.test(email)) {
      return NextResponse.json(
        { error: "That email doesn't look right." },
        { status: 400 }
      );
    }

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("Missing SLACK_WEBHOOK_URL");
      return NextResponse.json(
        { error: "Feedback is temporarily unavailable." },
        { status: 503 }
      );
    }

    const fields: { type: "mrkdwn"; text: string }[] = [
      { type: "mrkdwn", text: `*Feedback:*\n${message}` },
    ];
    if (name) fields.push({ type: "mrkdwn", text: `*Name:*\n${name}` });
    if (email) fields.push({ type: "mrkdwn", text: `*Email:*\n${email}` });
    if (context) fields.push({ type: "mrkdwn", text: `*Context:*\n${context}` });

    const slackPayload = {
      text: `New OpenVPM feedback`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "💬 New OpenVPM feedback" },
        },
        { type: "section", fields },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Source: openvpm.com/feedback · ${new Date().toISOString()}`,
            },
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
      const text = await res.text();
      console.error("Slack webhook error:", res.status, text);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Feedback error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
