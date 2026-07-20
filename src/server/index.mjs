import { createDashboardServer } from './app.mjs';

const host = process.env.FULL_BI_HOST || '127.0.0.1';
const parsedPort = Number.parseInt(process.env.FULL_BI_PORT || '3100', 10);

if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
  throw new RangeError('FULL_BI_PORT must be an integer between 0 and 65535.');
}

const server = createDashboardServer({ dataFile: process.env.FULL_BI_DATA_FILE });

server.listen(parsedPort, host, () => {
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : parsedPort;
  console.log(`Full-managed BI is available at http://${host}:${activePort}`);
});

function shutdown(signal) {
  server.close((error) => {
    if (error) {
      console.error(`Failed to stop after ${signal}:`, error);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
