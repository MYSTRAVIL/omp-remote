import { z } from "zod";

// Zod probes `new Function` to compile faster object parsers, and a schema
// takes the probe's answer when it is built. The aggregator's CSP forbids eval,
// so the probe is a policy violation. Each entry point imports this module
// first, before any schema exists, so Zod never probes.
z.config({ jitless: true });
