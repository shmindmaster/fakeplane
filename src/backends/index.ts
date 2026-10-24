import { World, type FaultSpec } from "../world.js";
import { GenericBackend, type GenericSeed } from "./generic.js";
import { LinearBackend, type LinearSeed } from "./linear.js";
import { SlackBackend, type SlackSeed } from "./slack.js";
import { ZendeskBackend, type ZendeskSeed } from "./zendesk.js";

export { GenericBackend, LinearBackend, SlackBackend, ZendeskBackend };
export type { GenericSeed, LinearSeed, SlackSeed, ZendeskSeed };

export const BACKEND_NAMES = ["zendesk", "slack", "linear", "generic"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export interface Seed {
  zendesk?: ZendeskSeed;
  slack?: SlackSeed;
  linear?: LinearSeed;
  generic?: GenericSeed;
}

export interface CreateWorldOptions {
  scenario?: string;
  clock?: string;
  seed?: Seed;
  faults?: FaultSpec[];
  /** Backends to enable. Defaults to those present in `seed`, or all four when the seed is empty. */
  backends?: BackendName[];
}

export function createWorld(options: CreateWorldOptions = {}): World {
  const seed = options.seed ?? {};
  const world = new World({ scenario: options.scenario, clock: options.clock, faults: options.faults });
  const seeded = BACKEND_NAMES.filter((n) => seed[n] !== undefined);
  const enabled = options.backends ?? (seeded.length ? seeded : [...BACKEND_NAMES]);
  for (const name of enabled) {
    if (name === "zendesk") world.addBackend(new ZendeskBackend(world, seed.zendesk));
    else if (name === "slack") world.addBackend(new SlackBackend(world, seed.slack));
    else if (name === "linear") world.addBackend(new LinearBackend(world, seed.linear));
    else if (name === "generic") world.addBackend(new GenericBackend(world, seed.generic));
    else throw new Error(`Unknown backend ${String(name)}`);
  }
  return world;
}
