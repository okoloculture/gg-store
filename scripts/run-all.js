/**
 * Прогон всех состязательных сценариев подряд.
 * Требует запущенного сервера (npm start) на чистой базе (npm run reset).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const SCENARIOS = [
  ['Однократная выдача под 50 параллельными вебхуками', 'race-webhooks.js'],
  ['Двойной клик "Купить"', 'race-buy.js'],
  ['Вебхуки вне порядка и раньше заказа', 'race-out-of-order.js'],
  ['Ловушка таймаута поставщика', 'race-timeout.js'],
  ['Пустой пул, восстановление и повторная выдача', 'race-out-of-stock.js'],
  ['Лимит промокода под параллельными запросами', 'race-promo.js'],
];

const runScenario = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, file)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

const run = async () => {
  const results = [];
  for (const [title, file] of SCENARIOS) {
    process.stdout.write(`\n########## ${title} ##########\n`);
    results.push([title, await runScenario(file)]);
  }

  process.stdout.write('\n########## Сводка ##########\n');
  for (const [title, code] of results) {
    process.stdout.write(`${code === 0 ? '[OK]  ' : '[FAIL]'} ${title}\n`);
  }
  process.exitCode = results.every(([, code]) => code === 0) ? 0 : 1;
};

run();
