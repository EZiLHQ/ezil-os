/**
 * The frozen interview recording notice, version 1 (docs/contracts/interview-evidence-v1.md §4,
 * interview-evidence-v1.vectors.json `notice`). Staging only.
 *
 * These are the EXACT bytes a candidate sees before the computer opens: UTF-8, LF line endings,
 * a trailing newline, 1972 bytes, pinned by sha256. OS serves exactly these bytes and refuses an
 * accept carrying any other version or sha256 (`notice_mismatch`). A different text is a new
 * version, and v1 code must refuse it. `interview-evidence-v1.notice.test.ts` proves the embedded
 * text hashes to `NOTICE_SHA256` AND equals the vectors file byte-for-byte.
 */
export const NOTICE_VERSION = 1 as const;

/** Pinned in the frozen contract. The one accepted sha256; the authority an accept is checked against. */
export const NOTICE_SHA256 = 'a73e2521409a299375aeac8dfb21d95a7daab7e788405d6dda4e4a064f0e7336' as const;

/** The notice bytes, embedded verbatim from the vectors file. Do not edit by hand. */
export const NOTICE_TEXT = "EZiL interview recording notice (version 1)\n\nThis is a recorded interview on EZiL OS staging. Read what is recorded before your computer opens. Nothing is recorded before you accept, and recording stops when the interviewer finishes the interview.\n\nWhat is recorded:\n- Which EZiL ID, EZiL OS account and EZiL Works account you use for this interview.\n- When this interview repository was created and prepared, and each time Git access to it is renewed. Renewals happen only while you are active in Code, so they do not show how long the repository was open.\n- Your commits and pushes to this repository: branch, commit IDs, messages, authors and times. Your pushes are not run on any test runner.\n- Every AI request made from your EZiL OS account during the interview: the model, timing, token counts, and the full prompt and response, including any code or file content sent with it (up to 2 MB per request).\n- Whether this browser tab is visible or hidden, whether this window has focus, which EZiL OS app is focused, and how long since Code was last visible and focused, in buckets: under 15 seconds, 15 to 60 seconds, 1 to 5 minutes, over 5 minutes.\n- When each AI agent request in Code starts and ends, with the number of tool calls it made of each kind: read, search, write, other.\n\nWhat is not recorded: camera, microphone, face data, screenshots, keystrokes, clipboard, the web addresses you visit, or anything outside this staging account.\n\nWhat cannot be known from this record: where you were or what you did while this tab was hidden; other devices or monitors; whether you were reading or away while the tab was visible but idle. A gap in the record means unknown, not away.\n\nRetention: AI prompts and responses are kept for 14 days and activity records for 30 days. The interviewer keeps the exported timeline. This record is not scored, and no attention or cheating judgement is made from it.\n\nAfter the interview is finished, this repository is read-only.\n";

/** The `notice` object returned by the consent `status` action for the candidate. */
export const INTERVIEW_NOTICE = { version: NOTICE_VERSION, sha256: NOTICE_SHA256, text: NOTICE_TEXT } as const;
