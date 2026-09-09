// Process entry point.
//
// Task A11 replaces this with real config loading, an HTTP listener, and the
// graceful shutdown sequence from SPEC.md. For now it exists so that the
// toolchain can be verified end to end: TypeScript type checking, Node's
// runtime type stripping, and the npm scripts that drive both.

/** The facts logged once at startup, so a running process is identifiable. */
type Startup = {
  readonly node: string;
  readonly env: string;
};

/**
 * Collects the runtime facts worth recording at boot.
 *
 * @returns The Node version and the resolved environment name.
 */
function describeStartup(): Startup {
  return {
    node: process.version,
    env: process.env['NODE_ENV'] ?? 'development',
  };
}

const startup = describeStartup();

console.log(
  JSON.stringify({
    level: 'info',
    message: 'scaffold ready',
    ...startup,
  }),
);
