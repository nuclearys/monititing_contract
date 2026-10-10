import type { createRegistryRepository } from './registry.js';

/**
 * Transitional repository contract. The SQL implementation is still being
 * moved out of registry.ts, while consumers already depend on domain-shaped
 * repositories instead of the entire registry object.
 */
export type RegistryRepository = ReturnType<typeof createRegistryRepository>;
