// Process entry point.
//
// Task A11 replaces this with real config loading, an HTTP listener, and the
// graceful shutdown sequence from SPEC.md. For now it exists so that the
// toolchain can be verified end to end: TypeScript type checking, Node's
// runtime type stripping, and the npm scripts that drive both.

type Startup = {
  readonly node: string;
  readonly env: string;
};

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
