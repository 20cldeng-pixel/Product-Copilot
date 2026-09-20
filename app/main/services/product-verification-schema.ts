import { z } from "zod";

const text = z.string().min(1);
export const verificationPlanSchema = z.object({
  scopeDigest: text, artifactDigest: text,
  bindings: z.record(text, z.array(text).max(500)), approvedAt: z.iso.datetime(),
}).strict();
export const criterionSchema = z.object({ id: text, requirementId: text, title: text, text }).strict();
export const verificationReportSchema = z.object({
  artifactDigest: text, finishedArtifactDigest: text, exitCode: z.number().int().nullable(),
  problem: text.optional(), stdout: z.string(), stderr: z.string(), rawReport: z.string().optional(),
  cases: z.array(z.object({
    key: text, file: text, name: text, status: z.enum(["passed", "failed", "pending"]), messages: z.array(z.string()),
  }).strict()),
  finishedAt: z.iso.datetime(), nodeVersion: text, vitestVersion: text,
}).strict();
export const manualVerificationSchema = z.object({
  id: z.uuid(), runId: z.uuid(), criterionId: text, decision: z.enum(["verified", "exception"]),
  reason: z.string().trim().min(1).max(4000), artifactDigest: text, observedAt: z.iso.datetime(),
}).strict();
