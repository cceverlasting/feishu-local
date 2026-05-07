import { randomUUID } from "node:crypto";

export function createJobId() {
  return `job_${randomUUID()}`;
}

export function createRequestId() {
  return `req_${randomUUID()}`;
}

export function createTraceId() {
  return `trace_${randomUUID()}`;
}
