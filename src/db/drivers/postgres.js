import pg from 'pg';


/**
 * Перевод общего диалекта в Postgres.
 *
 * SQL по всему проекту пишется с плейсхолдерами `?` и `INSERT OR IGNORE`
 * (диалект SQLite как базовый). Здесь он приводится к Postgres, чтобы один и
 * тот же запрос выполнялся на обоих движках без ветвлений в сервисах.
 */
export const toPostgres = (text) => {
  let out = '';
  let index = 0;
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }

  const ignore = /^(\s*)INSERT\s+OR\s+IGNORE\s+/i.exec(out);
  if (ignore) {
    out = `${ignore[1]}INSERT ${out.slice(ignore[0].length)} ON CONFLICT DO NOTHING`;
  }
  return out;
};

// bigint (int8) и COUNT(*) иначе приходят строками и ломают сравнения в JS.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const sslOptions = (connectionString) => {
  if (process.env.PGSSL_DISABLE === '1') return false;
  if (/sslmode=disable/.test(connectionString)) return false;
  return { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' };
};

export const createPostgresDriver = ({ connectionString, maxConnections, statementTimeoutMs }) => {
  const pool = new pg.Pool({
    connectionString,
    ssl: sslOptions(connectionString),
    max: maxConnections,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeoutMs,
  });

  const query = async (runner, text, params) => runner.query(toPostgres(text), params);

  const wrap = (runner) => ({
    get: async (text, params) => (await query(runner, text, params)).rows[0] ?? null,
    all: async (text, params) => (await query(runner, text, params)).rows,
    run: async (text, params) => (await query(runner, text, params)).rowCount ?? 0,
    exec: async (text) => {
      await runner.query(text);
    },
  });

  const poolRunner = wrap(pool);

  return {
    dialect: 'postgres',
    uniqueTarget: (error) =>
      (error?.code === '23505' ? error.constraint ?? error.table ?? 'unknown' : null),
    ...poolRunner,

    /**
     * Транзакция держит одно соединение: условные UPDATE внутри неё должны
     * видеть и блокировать те же строки, поэтому пул тут не годится.
     */
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // соединение уже разорвано
        }
        throw error;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
};
