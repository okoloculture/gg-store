import http from 'node:http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { createHandler } from './app.js';
import { startReconciler } from './services/reconciler.js';
import { seed } from './db/seed.js';

await seed();

const server = http.createServer(createHandler());

server.listen(config.port, config.host, () => {
  logger.info('сервер запущен', {
    url: `http://${config.host}:${config.port}`,
    admin: `http://${config.host}:${config.port}/admin.html`,
    driver: config.dbDriver,
  });
});

// В serverless-режиме периодического процесса не существует: его роль играют
// планировщик платформы и точечная сверка при опросе статуса заказа.
const stopReconciler = config.serverless ? () => {} : startReconciler();

const shutdown = () => {
  stopReconciler();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
