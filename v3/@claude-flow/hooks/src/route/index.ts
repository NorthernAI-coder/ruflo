/**
 * Route submodule — ADR-132 SimulativePlanningRouter
 *
 * Provides selective depth-allocation primitives for the hooks route hook.
 * Import via `@claude-flow/hooks/route`.
 *
 * @module @claude-flow/hooks/route
 */

export {
  maybeSimulatePlan,
  shouldSimulate,
  buildShadowPrompt,
  parseShadowResponse,
} from './simulative-planning-router.js';

export type {
  SimulativePlanResult,
  RouteContext,
  HaikuClient,
  SonaCache,
} from './simulative-planning-router.js';
