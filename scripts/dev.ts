export {};

const procs = [
  Bun.spawn(['bun', 'run', 'dev:server'], { stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn(['bun', 'run', 'dev:client'], { stdout: 'inherit', stderr: 'inherit' }),
];

function shutdown() {
  for (const proc of procs) proc.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const proc of procs) await proc.exited;
shutdown();
