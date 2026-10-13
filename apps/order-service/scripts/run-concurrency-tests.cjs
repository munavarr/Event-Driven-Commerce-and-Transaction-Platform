const { spawnSync } = require('node:child_process');
const path = require('node:path');

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://commerce_app:local_dev_password@127.0.0.1:5434/commerce_orders_test';
const composeArgs = ['compose', '-f', 'infra/docker-compose.yml'];
const projectRoot = path.resolve(__dirname, '../../..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function isHealthy() {
  const result = spawnSync(
    'docker',
    [...composeArgs, 'exec', '-T', 'postgres-test', 'pg_isready', '-U', 'commerce_app', '-d', 'commerce_orders_test'],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  return result.status === 0;
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (isHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('postgres-test did not become healthy within 30 seconds');
}

async function main() {
  run('docker', [...composeArgs, 'up', '-d', 'postgres-test'], {
    cwd: projectRoot,
  });
  await waitForDatabase();

  const environment = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    TEST_DATABASE_URL: testDatabaseUrl,
  };
  run('pnpm', ['--filter', 'order-service', 'db:migrate'], {
    cwd: projectRoot,
    env: environment,
  });
  run('pnpm', ['--filter', 'order-service', 'test:concurrency'], {
    cwd: projectRoot,
    env: environment,
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
