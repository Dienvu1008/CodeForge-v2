/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Control (Phase 9) — unified control admission over the existing kernel.
// ControlPlane (P9.7) — pure admission for every external control action. OB-006.
export * from './control-plane.js';
// InterventionRecord (P9.9) — unified auditable record of a control intervention. OB-006.
export * from './intervention-record.js';
