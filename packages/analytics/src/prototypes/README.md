# Prototypes

This folder is reserved for non-production analytics experiments and future
Phase 3 ML decisioning work.

Current production behavior:
- `packages/analytics/src/intervention-decision.js`
- uses the rule-based threshold/blend `evaluate()` path only

Prototype-only files in this folder:
- `logistic-regression-evaluate.js`
- `decision-models-registry.js`

Do not import these files into the live intervention route until the model
registry, rollout controls, and rollback plan are production-ready.
