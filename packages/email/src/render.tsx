import * as React from "react";
import { render } from "@react-email/render";
import { WelcomeEmail, type WelcomeEmailProps } from "./templates/WelcomeEmail";
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
