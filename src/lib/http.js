import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { logger } from './logger.js';

const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const asObject = (value) => {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return asObject(value.toString('utf8'));
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new AppError(400, 'invalid_json', 'Тело запроса не является корректным JSON');
    }
  }
  return typeof value === 'object' ? value : {};
};

export const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve({});
      return;
    }
    // Serverless-платформа разбирает тело до вызова обработчика: поток уже
    // прочитан, и ждать в нём 'end' означало бы повиснуть навсегда.
    try {
      const parsed = asObject(req.body);
      if (parsed) {
        resolve(parsed);
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'payload_too_large', 'Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new AppError(400, 'invalid_json', 'Тело запроса не является корректным JSON'));
      }
    });
    req.on('error', reject);
  });

const compilePattern = (pattern) => {
  const names = [];
  const regexSource = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${regexSource}$`), names };
};

export const createRouter = () => {
  const routes = [];
  const add = (method, pattern, handler) => {
    routes.push({ method, handler, ...compilePattern(pattern) });
  };
  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    match: (method, pathname) => {
      for (const route of routes) {
        if (route.method !== method) continue;
        const found = route.regex.exec(pathname);
        if (!found) continue;
        const params = {};
        route.names.forEach((name, index) => {
          params[name] = decodeURIComponent(found[index + 1]);
        });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
};

export const serveStatic = (res, publicDir, pathname) => {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(publicDir, relative);
  if (!target.startsWith(publicDir)) {
    sendJson(res, 403, { error: { code: 'forbidden', message: 'Доступ запрещён' } });
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
  return true;
};

export const handleError = (res, error, context) => {
  if (error instanceof AppError) {
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  logger.error('необработанная ошибка запроса', { ...context, error: error?.message, stack: error?.stack });
  sendJson(res, 500, { error: { code: 'internal_error', message: 'Внутренняя ошибка' } });
};
