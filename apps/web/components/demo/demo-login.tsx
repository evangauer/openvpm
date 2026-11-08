"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  HeartPulse,
  LockKeyhole,
  PawPrint,
  Phone,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { DEMO_ROLE_OPTIONS } from "@/lib/demo-role-switcher";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { safeAuthNextPath } from "@/lib/auth-redirect";
import { signInToDemo } from "@/lib/demo-sign-in";
import { CURRENT_DEMO_DISCLOSURE_TEXT } from "@/lib/growth/demo-disclosure";
import {
  buildCloudSignupUrl,
  cloudSignupAppOrigin,
  FUNNEL_EVENTS,
} from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { getFunnelVisitorId, useFunnelVisitorId } from "@/lib/funnel-visitor";
import styles from "./demo-login.module.css";

const roleDetails = {
  admin: {
    description: "See the whole practice, from the team to the numbers.",
    icon: ShieldCheck,
  },
  veterinarian: {
    description: "Get to know a patient and explore their care.",
    icon: Stethoscope,
  },
  technician: {
    description: "Follow the treatment floor and keep visits moving.",
    icon: HeartPulse,
  },
  front_desk: {
    description: "Welcome patients and keep the day on track.",
    icon: Phone,
  },
};
const demoRoles = DEMO_ROLE_OPTIONS.map(({ value, label }) => ({
  id: value,
  label,
  ...roleDetails[value],
}));
const shots = {
  whiteboard: {
    src: "/demo/whiteboard.jpg",
    alt: "OpenVPM sample clinic: the clinic board",
  },
  "visit-clinical-work": {
    src: "/demo/patient-record.jpg",
    alt: "OpenVPM sample clinic: a patient record",
  },
};
function ProductImage({
  id,
  priority = false,
}: {
  id: keyof typeof shots;
  priority?: boolean;
}) {
  const shot = shots[id];
  return (
    <Image
      src={shot.src}
      alt={shot.alt}
      width={1280}
      height={800}
      sizes="(max-width: 760px) 100vw, 65vw"
      priority={priority}
      className={styles.productImage}
    />
  );
}

export function DemoLogin() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const visitorId = useFunnelVisitorId();
  const nextPath = safeAuthNextPath(searchParams.get("next"), "/demo-start");
  const [role, setRole] = useState<(typeof demoRoles)[number] | null>(null);
  const [step, setStep] = useState<"role" | "email">("role");
  const [email, setEmail] = useState("");
  const [previewTab, setPreviewTab] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    trackFunnelEvent(FUNNEL_EVENTS.demoLand);
    trackFunnelEvent(FUNNEL_EVENTS.demoGateViewed);
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function chooseRole(selected: (typeof demoRoles)[number]) {
    setRole(selected);
    setError("");
    setStep("email");
  }

  async function enterDemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!role || submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError("");
    try {
      await signInToDemo(
        {
          email,
          role: role.id,
          anonymousId: visitorId ?? getFunnelVisitorId() ?? undefined,
        },
        { fetch, signIn },
      );
      setEmail("");
      router.push(nextPath);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The demo is temporarily unavailable. Please try again.",
      );
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }
  const RoleIcon = role?.icon ?? ShieldCheck;

  return (
    <main id="main-content" className={styles.page}>
      <header className={styles.header}>
        <a
          href="https://openvpm.com"
          aria-label="OpenVPM home"
          className={styles.brand}
        >
          <span>
            <PawPrint size={21} aria-hidden="true" />
          </span>
          OpenVPM
        </a>
        <a href="https://openvpm.com" className={styles.backLink}>
          <ArrowLeft size={15} aria-hidden="true" /> Back to website
        </a>
      </header>
      <div className={styles.split}>
        <section className={styles.formPanel} aria-label="Demo setup">
          <div className={styles.formInner}>
            <ol className={styles.progress} aria-label="Your demo setup">
              <li aria-current={step === "role" ? "step" : undefined}>
                <span>
                  {step === "email" ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    "1"
                  )}
                </span>
                Choose a role
              </li>
              <li className={styles.progressLine} aria-hidden="true" />
              <li aria-current={step === "email" ? "step" : undefined}>
                <span>2</span>Your email
              </li>
            </ol>

            {step === "role" ? (
              <>
                <h1 ref={heading} tabIndex={-1}>
                  A day in your shoes.
                </h1>
                <p className={styles.intro}>
                  Walk through OpenVPM with a clinic full of sample data. Who
                  would you like to be?
                </p>
                <div className={styles.roles}>
                  {demoRoles.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        className={styles.role}
                        onClick={() => chooseRole(item)}
                      >
                        <span className={styles.roleIcon}>
                          <Icon
                            size={22}
                            strokeWidth={1.7}
                            aria-hidden="true"
                          />
                        </span>
                        <span>
                          <strong>{item.label}</strong>
                          <span className={styles.roleDescription}>
                            {item.description}
                          </span>
                        </span>
                        <ArrowRight
                          size={18}
                          className={styles.roleArrow}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </div>
                <p className={styles.reassurance}>
                  <Check size={15} aria-hidden="true" />
                  No setup. No credit card. Just explore.
                </p>
              </>
            ) : (
              <>
                <button
                  className={styles.changeRole}
                  disabled={loading}
                  onClick={() => {
                    setError("");
                    setStep("role");
                  }}
                >
                  <ArrowLeft size={15} aria-hidden="true" />
                  Choose a different role
                </button>
                <h1 ref={heading} tabIndex={-1}>
                  One last thing.
                  <br />
                  Drop your email.
                </h1>
                <p className={styles.intro}>
                  Your sample clinic is ready. Let’s get you in.
                </p>
                <div className={styles.selectedRole}>
                  <span className={styles.roleIcon}>
                    <RoleIcon size={22} aria-hidden="true" />
                  </span>
                  <div>
                    <small>YOU’RE EXPLORING AS</small>
                    <strong>{role?.label}</strong>
                  </div>
                  <CheckCircle2 size={19} aria-hidden="true" />
                </div>
                <form
                  onSubmit={enterDemo}
                  className={styles.emailForm}
                  aria-busy={loading}
                >
                  {error && (
                    <p role="alert" className={styles.error}>
                      {error}
                    </p>
                  )}
                  <label htmlFor="demo-email">Email address</label>
                  <input
                    id="demo-email"
                    type="email"
                    name="email"
                    required
                    maxLength={AUTH_EMAIL_MAX_LENGTH}
                    disabled={loading}
                    autoComplete="email"
                    inputMode="email"
                    placeholder="you@yourclinic.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    aria-describedby="email-purpose"
                  />
                  <p id="email-purpose" className={styles.disclosure}>
                    {CURRENT_DEMO_DISCLOSURE_TEXT}
                  </p>
                  <button
                    className={styles.primary}
                    type="submit"
                    disabled={loading}
                  >
                    {loading ? "Opening demo…" : "Enter the demo"}
                    <ArrowRight size={18} aria-hidden="true" />
                  </button>
                </form>
                <p className={styles.reassurance}>
                  <LockKeyhole size={14} aria-hidden="true" />
                  No password or credit card needed.
                </p>
              </>
            )}
            <p className={styles.startClinic}>
              Ready for your own workspace?{" "}
              <a
                href={buildCloudSignupUrl({
                  appOrigin: cloudSignupAppOrigin(),
                  source: "demo",
                  medium: "product",
                  campaign: "demo_login",
                  visitorId,
                })}
                onClick={() =>
                  trackFunnelEvent(FUNNEL_EVENTS.demoCtaStartClinic, {
                    tool: "login",
                    path: "/login",
                  })
                }
              >
                Start my clinic
              </a>
            </p>
          </div>
        </section>

        <aside className={styles.showcase} aria-label="A look inside OpenVPM">
          <div className={styles.showcaseCopy}>
            <span className={styles.liveDot} aria-hidden="true" />A LITTLE LOOK
            INSIDE
            <h2>
              A whole clinic.
              <br />
              Ready to explore.
            </h2>
            <p>
              Patients to meet. Visits to follow.
              <br />
              See how the day comes together in OpenVPM.
            </p>
          </div>
          <div className={styles.previewWindow}>
            <div className={styles.browserBar}>
              <span className={styles.browserDots} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>OpenVPM · Sample clinic</span>
              <LockKeyhole size={12} aria-hidden="true" />
            </div>
            <ProductImage
              id={previewTab === 0 ? "whiteboard" : "visit-clinical-work"}
              priority
            />
          </div>
          <div className={styles.previewTabs} aria-label="Product preview">
            <button
              aria-pressed={previewTab === 0}
              onClick={() => setPreviewTab(0)}
            >
              The clinic board
            </button>
            <button
              aria-pressed={previewTab === 1}
              onClick={() => setPreviewTab(1)}
            >
              The patient record
            </button>
          </div>
          <p className={styles.sampleNote}>
            <PawPrint size={16} aria-hidden="true" />
            Real product. Fictional patients. Room to explore.
          </p>
        </aside>
      </div>
    </main>
  );
}
