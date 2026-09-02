import { createHandler } from '../src/app.js';
import { ensureReady } from '../src/db/bootstrap.js';

// Статику (public/) раздаёт сама платформа, до функции такие запросы не доходят.
const handler = createHandler({ static: false });

export default async function vercelHandler(req, res) {
  await ensureReady();
  return handler(req, res);
}
