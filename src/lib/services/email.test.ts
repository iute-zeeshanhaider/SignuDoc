import assert from "node:assert/strict";
import { test } from "node:test";

import type { SendMailOptions } from "nodemailer";
import type { Resend } from "resend";

import {
  canSendEmail,
  createEmailService,
  createLazyEmailService,
  resolveEmailDriver,
  type EmailService,
} from "./email.ts";

// What the Resend client is asked to do when the service turns a request
// away for rate. Nothing here talks to Resend.

type Answer = {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: Record<string, string> | null;
};

const RATE_LIMITED: Answer = {
  data: null,
  error: {
    message:
      "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  headers: { "retry-after": "1" },
};

const SENT: Answer = { data: { id: "email_1" }, error: null, headers: {} };

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

/** An email service whose Resend client gives these answers, in order. */
function serviceAnswering(answers: Answer[]) {
  const waits: number[] = [];
  let requests = 0;
  const next = async () => {
    const answer = answers[Math.min(requests, answers.length - 1)];

    requests += 1;

    return answer;
  };
  const service = createEmailService({
    resendClient: {
      batch: { send: next },
      emails: { send: next },
    } as unknown as Resend,
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: null,
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { requests: () => requests, service, waits };
}

test("a message Resend turns away for rate is sent again after the wait it names", async () => {
  const { requests, service, waits } = serviceAnswering([
    RATE_LIMITED,
    { ...RATE_LIMITED, headers: { "retry-after": "2" } },
    SENT,
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "email_1");
  assert.equal(requests(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("a rate limit that does not clear is reported after a few tries", async () => {
  const { requests, service, waits } = serviceAnswering([RATE_LIMITED]);

  await assert.rejects(service.send(MESSAGE), /Too many requests/);
  // The first try and three more.
  assert.equal(requests(), 4);
  assert.equal(waits.length, 3);
});

test("the wait is a second when Resend names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    { ...RATE_LIMITED, headers: null },
    { ...RATE_LIMITED, headers: { "retry-after": "3600" } },
    SENT,
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a used-up quota is reported at once: waiting a second does not bring it back", async () => {
  const { requests, service, waits } = serviceAnswering([
    {
      data: null,
      error: {
        message: "You have exceeded your daily email sending quota.",
        name: "daily_quota_exceeded",
        statusCode: 429,
      },
      headers: { "retry-after": "1" },
    },
  ]);

  await assert.rejects(service.send(MESSAGE), /daily email sending quota/);
  assert.equal(requests(), 1);
  assert.deepEqual(waits, []);
});

test("a batch turned away for rate is sent again too", async () => {
  const { requests, service } = serviceAnswering([
    RATE_LIMITED,
    {
      data: { data: [{ id: "email_1" }] } as unknown as { id: string },
      error: null,
      headers: {},
    },
  ]);

  const deliveries = await service.sendBatch([MESSAGE]);

  assert.equal(deliveries[0]?.messageId, "email_1");
  assert.equal(requests(), 2);
});

test("a lazy email service is only built when it first sends, and only once", async () => {
  let built = 0;
  const service = createLazyEmailService(() => {
    built += 1;

    return {
      async send(message) {
        return { accepted: [message.to], messageId: "m-1", rejected: [] };
      },
      async sendBatch() {
        return [];
      },
    } satisfies EmailService;
  });

  assert.equal(built, 0);
  await service.send(MESSAGE);
  await service.sendBatch([MESSAGE]);
  assert.equal(built, 1);
});

test("a lazy email service with no provider fails the send, not its creation (issue #96)", async () => {
  const service = createLazyEmailService(() => createEmailService({ env: {} }));

  await assert.rejects(service.send(MESSAGE), /RESEND_API_KEY/);
});

test("signup knows when there is no email provider to send with (issue #95)", () => {
  assert.equal(canSendEmail({ NODE_ENV: "production" }), false);
  assert.equal(
    canSendEmail({ NODE_ENV: "production", RESEND_API_KEY: "re_test" }),
    true,
  );
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "capture", NODE_ENV: "development" }),
    true,
  );
  // The capture driver drops mail, so a real site cannot count on it.
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
});

/** An email service whose SMTP transport records the messages it is given. */
function smtpService() {
  const sent: SendMailOptions[] = [];
  const service = createEmailService({
    env: { EMAIL_DRIVER: "smtp" },
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: "help@example.test",
    }),
    smtpTransport: {
      async sendMail(options) {
        sent.push(options);

        return {
          accepted: [String(options.to)],
          messageId: `smtp-${String(sent.length)}`,
        };
      },
    },
  });

  return { sent, service };
}

test("smtp is a known driver and does not need a Resend key", () => {
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "smtp" }), "smtp");
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "SMTP" }), "smtp");
  assert.equal(canSendEmail({ EMAIL_DRIVER: "smtp" }), true);
});

test("the smtp driver hands the message and its attachments to the transport", async () => {
  const { sent, service } = smtpService();

  const delivery = await service.send({
    ...MESSAGE,
    attachments: [
      {
        content: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
        filename: "signed-copy.pdf",
      },
    ],
    htmlBody: "<p>Attached.</p>",
  });

  assert.equal(delivery.messageId, "smtp-1");
  assert.equal(sent[0]?.from, "Example <hello@example.test>");
  assert.equal(sent[0]?.to, "signer@example.test");
  assert.equal(sent[0]?.replyTo, "help@example.test");
  assert.equal(sent[0]?.subject, MESSAGE.subject);
  assert.equal(sent[0]?.text, MESSAGE.textBody);
  assert.equal(sent[0]?.html, "<p>Attached.</p>");

  const [attachment] = sent[0]?.attachments ?? [];
  assert.equal(
    (attachment as { filename?: string } | undefined)?.filename,
    "signed-copy.pdf",
  );
  assert.deepEqual(
    [
      ...((attachment as { content?: Buffer } | undefined)?.content ??
        Buffer.alloc(0)),
    ],
    [1, 2, 3],
  );
});

test("the smtp driver sends a batch one message at a time", async () => {
  const { sent, service } = smtpService();

  const deliveries = await service.sendBatch([
    MESSAGE,
    { ...MESSAGE, to: "second@example.test" },
    { ...MESSAGE, to: "third@example.test" },
  ]);

  assert.deepEqual(
    sent.map((message) => message.to),
    ["signer@example.test", "second@example.test", "third@example.test"],
  );
  assert.deepEqual(
    deliveries.map((delivery) => delivery.messageId),
    ["smtp-1", "smtp-2", "smtp-3"],
  );
});
