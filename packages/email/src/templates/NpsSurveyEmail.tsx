import * as React from "react";
import type { Brand } from "../brand";
import { theme } from "../theme";
import { P, PersonalNote } from "../components/PersonalNote";

export interface NpsSurveyEmailProps {
  brand: Brand;
  practiceName: string;
  greetingName: string | null;
  senderName: string | null;
  /** Eleven signed links, for scores 0 through 10. */
  scoreUrls: string[];
  unsubscribeUrl?: string;
}

export function npsSurveySubject(): string {
  return "One quick question about OpenVPM";
}

const cell: React.CSSProperties = {
  display: "inline-block",
  minWidth: "28px",
  padding: "6px 0",
  margin: "0 4px 6px 0",
  border: `1px solid ${theme.border}`,
  borderRadius: "6px",
  textAlign: "center",
  fontFamily: theme.fontBody,
  fontSize: "14px",
  fontWeight: 600,
  color: theme.brandDark,
  textDecoration: "none",
};

/** The Net Promoter question, answered with one click. */
export function NpsSurveyEmail({
  brand,
  practiceName,
  greetingName,
  senderName,
  scoreUrls,
  unsubscribeUrl,
}: NpsSurveyEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview="How likely are you to recommend OpenVPM to another clinic?"
      greetingName={greetingName}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You're receiving this because you run ${practiceName} on OpenVPM.`}
    >
      <P>
        One question, and it takes a second: how likely are you to recommend
        OpenVPM to another clinic?
      </P>
      <P style={{ margin: "0 0 4px" }}>
        {scoreUrls.map((url, score) => (
          <a key={url} href={url} style={cell}>
            {score}
          </a>
        ))}
      </P>
      <P style={{ fontSize: "12px", color: theme.subtle }}>
        0 = not at all likely, 10 = extremely likely
      </P>
      <P>
        You can add a comment on the next page. Every answer comes straight to
        me.
      </P>
    </PersonalNote>
  );
}
