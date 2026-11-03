import type { Guide } from "../types";

export const checkout: Guide[] = [
  {
    slug: "capture-visit-charges",
    title: "Capture visit charges",
    summary: "Add the services and products from the visit to a draft invoice.",
    category: "checkout",
    area: "billing",
    audience: "Front desk, admins",
    minutes: 4,
    before: "The visit needs a client and a pet, and it must be [[In Exam]]. Before the exam starts, or after checkout, charges are read-only.",
    keywords: ["charges", "bill", "line items", "services", "products", "draft invoice", "charge capture"],
    steps: [
      {
        id: "open",
        title: "Open Charge capture on the visit",
        body: [
          "Open the visit and find **Charge capture** ((1)). Front desk and admins can add charges. Vets and techs can see them but not change them.",
        ],
        shot: {
          id: "visit-exam",
          focus: "charge-capture",
          pad: 12,
          callouts: ["charge-capture"],
          alt: "The Charge capture section on a visit page",
        },
      },
      {
        id: "add",
        title: "Add services and products",
        body: ["Choose each service you performed and each product you dispensed. Check the quantity and price, then add it. Look closely at prescription charges and any stock warnings."],
      },
      {
        id: "save",
        title: "Save the draft invoice",
        body: ["Check the subtotal, tax, and total, then save. You can still change a draft until you present it to the client."],
      },
    ],
    next: "create-and-present-an-invoice",
  },
  {
    slug: "create-and-present-an-invoice",
    title: "Create and present an invoice",
    summary: "Check the bill, mark it sent, and give it to the client.",
    category: "checkout",
    area: "billing",
    audience: "Front desk, admins",
    minutes: 4,
    before: "Only admins and front desk staff can create or change invoices.",
    keywords: ["invoice", "bill", "estimate", "pdf", "email invoice", "send invoice", "mark as sent"],
    steps: [
      {
        id: "review",
        title: "Check the draft",
        body: [
          "Open [[Billing]] and click the invoice to expand it. Check the client, pet, items, quantities, prices, tax, total, and due date.",
          "Use the tabs ((1)) to see only drafts, sent, paid, or overdue invoices. Estimates have their own tab and stay separate until you convert them.",
        ],
        shot: {
          id: "billing",
          focus: ["tabs", "list"],
          pad: 12,
          callouts: ["tabs"],
          alt: "The Billing screen with tabs for All, Draft, Sent, Paid, Overdue, Void, and Estimates above a list of invoices",
        },
      },
      {
        id: "send",
        title: "Mark it as sent",
        body: ["When the invoice is ready, choose [[Mark as Sent]]. A sent or overdue invoice with a balance can take payment."],
      },
      {
        id: "deliver",
        title: "Give it to the client",
        body: [
          "Choose [[Download PDF]] to print it or go over it together. Or choose [[Email Invoice]] ((1)) to send the client a secure payment link. Email needs a client email address and a configured email provider.",
        ],
        shot: {
          id: "invoice-sent",
          focus: "payments",
          pad: 16,
          callouts: ["email"],
          alt: "An expanded invoice with Download PDF and Email Invoice buttons",
        },
      },
    ],
    next: "take-a-payment",
  },
  {
    slug: "take-a-payment",
    title: "Take a payment",
    summary: "Take a card, or record cash, check, or a payment on your own terminal.",
    category: "checkout",
    area: "billing",
    audience: "Front desk, admins",
    minutes: 4,
    before: "The invoice must be sent or overdue and have a balance. You need to be signed in as front desk or an admin.",
    keywords: ["pay", "payment", "card", "cash", "check", "credit card", "terminal", "stripe", "checkout", "collect"],
    steps: [
      {
        id: "open",
        title: "Open the invoice",
        body: ["Go to [[Billing]], find the client's invoice, and click it to expand it. Check what's been paid and what's left."],
      },
      {
        id: "method",
        title: "Choose how they're paying",
        body: [
          "For cash, check, your own card terminal, or a payment taken somewhere else, choose [[Record Payment]] ((1)). Enter the amount and method, and add a note like a check number if you want.",
          "To take a card in OpenVPM, choose [[Take Card]] ((2)). This only works once card payments are set up.",
        ],
        shot: {
          id: "invoice-sent",
          focus: "payments",
          pad: 16,
          callouts: ["record-payment", "take-card"],
          alt: "The payments area of an invoice with Record Payment and Take Card highlighted",
        },
      },
      {
        id: "verify",
        title: "Check the balance and finish",
        body: ["Make sure the payment shows in the history and the balance is right. A fully paid invoice is ready for checkout."],
        important: "Taking cards online needs Stripe to be set up and tested. Recording cash, check, or an outside terminal payment doesn't.",
      },
    ],
    faq: [
      ["What payment methods can I record?", "Cash, credit card, debit card, check, online, and other. Use the note for a check number or terminal reference."],
      ["Can the client pay from home?", "Yes, when card payments and email are set up. Email the invoice, or share their [client portal](/guides/give-client-portal-access) link."],
      ["Why is Take Card greyed out?", "Make sure the invoice is sent or overdue and has a balance. Then check card payments in [[Settings]] → [[Plan & Billing]]. See [Set up card payments](/guides/set-up-client-card-payments)."],
    ],
    next: "place-a-balance-in-accounts-receivable",
  },
  {
    slug: "place-a-balance-in-accounts-receivable",
    title: "Let a client pay later",
    summary: "Finish the visit and keep the unpaid balance on file with a due date.",
    category: "checkout",
    area: "billing",
    audience: "Front desk, admins",
    minutes: 3,
    keywords: ["accounts receivable", "ar", "pay later", "balance", "due date", "owe", "credit"],
    steps: [
      {
        id: "invoice",
        title: "Check the invoice",
        body: ["The visit needs an invoice with items on it, a balance, and a due date."],
      },
      {
        id: "pay-later",
        title: "Choose Pay later",
        body: ["In the visit's closeout, choose [[Pay later — present with due date]] and confirm the due date."],
      },
      {
        id: "handoff",
        title: "Finish the owner handoff",
        body: ["Record how the owner got their discharge instructions, then finish the visit. The balance stays in accounts receivable."],
        important: "Finishing a pay-later visit doesn't charge a card or email the client.",
      },
    ],
    next: "refund-or-adjust-a-payment",
  },
  {
    slug: "refund-or-adjust-a-payment",
    title: "Refund or adjust a payment",
    summary: "Fix a balance with a refund, credit, or write-off, and a clear reason.",
    category: "checkout",
    area: "billing",
    audience: "Front desk, admins",
    minutes: 5,
    before: "Refunds need an admin. Credits and write-offs need billing access.",
    keywords: ["refund", "credit", "write off", "write-off", "adjust", "discount", "return money", "void"],
    steps: [
      {
        id: "history",
        title: "Check the invoice history",
        body: ["Open the invoice and check the original payment, method, amount, and current balance before you change anything."],
      },
      {
        id: "choose",
        title: "Choose a refund, credit, or write-off",
        body: [
          "Refund a specific payment when money goes back to the client.",
          "When your clinic's policy calls for adjusting the balance instead, choose [[Credit / Write Off]] ((1)).",
        ],
        shot: {
          id: "invoice-sent",
          focus: "payments",
          pad: 16,
          callouts: ["adjust"],
          alt: "The payments area of an invoice with Credit / Write Off highlighted",
        },
      },
      {
        id: "reason",
        title: "Give a clear reason",
        body: ["Write why, and check the new balance. Card payments taken through Stripe are refunded through Stripe."],
      },
    ],
    faq: [["Should I void the invoice instead?", "Void an invoice only when it shouldn't exist at all. Voiding can't be undone."]],
    next: "give-client-portal-access",
  },
];
