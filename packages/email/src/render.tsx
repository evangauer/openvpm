import * as React from "react";
import { render } from "@react-email/render";
import { WelcomeEmail, type WelcomeEmailProps } from "./templates/WelcomeEmail";
import {
  BuildFollowupEmail,
  buildFollowupSubject,
  type BuildFollowupEmailProps,
} from "./templates/BuildFollowupEmail";
import {
  TeamInviteEmail,
  teamInviteSubject,
  type TeamInviteEmailProps,
} from "./templates/TeamInviteEmail";
import {
  TrialWinbackEmail,
  trialWinbackSubject,
  type TrialWinbackEmailProps,
} from "./templates/TrialWinbackEmail";
import {
  AdoptionEmail,
  adoptionSubject,
  type AdoptionEmailProps,
} from "./templates/AdoptionEmail";
import {
  NpsSurveyEmail,
  npsSurveySubject,
  type NpsSurveyEmailProps,
} from "./templates/NpsSurveyEmail";
import {
  TrialEndingEmail,
  type TrialEndingEmailProps,
} from "./templates/TrialEndingEmail";
import {
  SetupRecoveryEmail,
  type SetupRecoveryEmailProps,
} from "./templates/SetupRecoveryEmail";
import {
  PaymentReceiptEmail,
  type PaymentReceiptEmailProps,
} from "./templates/PaymentReceiptEmail";
import {
  PaymentFailedEmail,
  type PaymentFailedEmailProps,
} from "./templates/PaymentFailedEmail";
import {
  FirstClinicWinEmail,
  type FirstClinicWinEmailProps,
} from "./templates/FirstClinicWinEmail";
import {
  CheckoutRecoveryEmail,
  checkoutRecoverySubject,
  type CheckoutRecoveryEmailProps,
} from "./templates/CheckoutRecoveryEmail";
import {
  DemoFollowupEmail,
  demoFollowupSubject,
  type DemoFollowupEmailProps,
} from "./templates/DemoFollowupEmail";

export interface RenderedEmail {
  subject: string;
  html: string;
}

export async function renderWelcomeEmail(
  p: WelcomeEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: `Welcome to OpenVPM, ${p.practiceName}`,
    html: await render(<WelcomeEmail {...p} />),
  };
}

export async function renderTrialEndingEmail(
  p: TrialEndingEmailProps,
): Promise<RenderedEmail> {
  const when = p.daysLeft <= 1 ? "tomorrow" : `in ${p.daysLeft} days`;
  return {
    subject: `Your OpenVPM trial ends ${when}`,
    html: await render(<TrialEndingEmail {...p} />),
  };
}

export async function renderSetupRecoveryEmail(
  p: SetupRecoveryEmailProps,
): Promise<RenderedEmail> {
  return {
    subject:
      p.attemptNumber === 1
        ? `Resume setup for ${p.practiceName}`
        : `Can we help with ${p.stepTitle}?`,
    html: await render(<SetupRecoveryEmail {...p} />),
  };
}

export async function renderPaymentReceiptEmail(
  p: PaymentReceiptEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: `Your OpenVPM receipt — ${p.amount}`,
    html: await render(<PaymentReceiptEmail {...p} />),
  };
}

export async function renderPaymentFailedEmail(
  p: PaymentFailedEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: "Action needed: your OpenVPM payment didn't go through",
    html: await render(<PaymentFailedEmail {...p} />),
  };
}

export async function renderFirstClinicWinEmail(
  p: FirstClinicWinEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: "Your first real OpenVPM visit is complete",
    html: await render(<FirstClinicWinEmail {...p} />),
  };
}

export async function renderCheckoutRecoveryEmail(
  p: CheckoutRecoveryEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: checkoutRecoverySubject(p.step, p.practiceName, p.previewActive),
    html: await render(<CheckoutRecoveryEmail {...p} />),
  };
}

export async function renderDemoFollowupEmail(
  p: DemoFollowupEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: demoFollowupSubject(p.step, p.tool),
    html: await render(<DemoFollowupEmail {...p} />),
  };
}

export async function renderTeamInviteEmail(
  p: TeamInviteEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: teamInviteSubject(p.practiceName),
    html: await render(<TeamInviteEmail {...p} />),
  };
}

export async function renderTrialWinbackEmail(
  p: TrialWinbackEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: trialWinbackSubject(p.step, p.practiceName),
    html: await render(<TrialWinbackEmail {...p} />),
  };
}

export async function renderAdoptionEmail(
  p: AdoptionEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: adoptionSubject(p.practiceName, p.tips.length),
    html: await render(<AdoptionEmail {...p} />),
  };
}

export async function renderNpsSurveyEmail(
  p: NpsSurveyEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: npsSurveySubject(),
    html: await render(<NpsSurveyEmail {...p} />),
  };
}

export async function renderBuildFollowupEmail(
  p: BuildFollowupEmailProps,
): Promise<RenderedEmail> {
  return {
    subject: buildFollowupSubject(p.step, p.clinicName),
    html: await render(<BuildFollowupEmail {...p} />),
  };
}
