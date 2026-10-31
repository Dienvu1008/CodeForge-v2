/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Goal service (P1-S2) — DOMAIN_CONTRACTS §3, GL-001..GL-004.
// NOTE: the Goal entity type is exported from domain/goal.ts (Phase 0).
export * from './goal-service.js';
// P10.9 — runtime goal ingress (queue new goals while the agent runs).
export * from './goal-ingress-service.js';
// session-resume v1 — durable goal queue port.
export * from './goal-queue-store.js';
